import mongoose from 'mongoose';
import { config } from '../../config/index.js';
import { BillingAccount } from '../../models/billing-account.js';
import { BillingApiCall } from '../../models/billing-api-call.js';
import { BillingEvent } from '../../models/billing-event.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { MeteringRecord, type IMeteringRecord } from '../../models/metering-record.js';
import { accountService, type AccountService } from './account-service.js';
import { creditCheckService, type CreditCheckRef, type CreditCheckService, type PreCheck } from './credit-check.js';
import { InvoicingService, invoicingService } from './invoicing.js';
import { availableCents, ceilMinutes, parseRechargeCents } from './money.js';
import { documentId } from './id.js';
import { MeteringService, meteringService } from './metering.js';
import { PaymentService, paymentService } from './payment.js';
import { PricingService, pricingService } from './pricing.js';
import { ReceiptService, receiptService } from './receipt.js';
import { ReservationService, reservationService } from './reservation.js';

export type DestroyContainer = (resourceId: string, reason: string) => Promise<void>;

/** 容器强制销毁原因（与 cloud-controller 契约约定一致，可审计）。 */
export const CONTAINER_FORCE_DESTROY_REASON = '余额不足超过 10 分钟，强制销毁';

export interface InvoiceResult {
  invoiceId: string;
  seq: number;
  receiptNo: string;
  balanceAfter: number;
  amount: number;
}

export interface BillingServiceOptions {
  accounts?: AccountService;
  payments?: PaymentService;
  prices?: PricingService;
  checks?: CreditCheckService;
  reservations?: ReservationService;
  invoicings?: InvoicingService;
  receipts?: ReceiptService;
  meterings?: MeteringService;
  now?: () => number;
  destroyContainer?: DestroyContainer;
}

/**
 * 计费管线编排（事件 → 计量 → 定价 → 账单 → 支付 → 收据）。
 * 业务事件由 MQ 消费者驱动，所有资金动作经 CreditCheckService + PaymentService。
 */
export class BillingService {
  private readonly accounts: AccountService;
  private readonly payments: PaymentService;
  private readonly prices: PricingService;
  private readonly checks: CreditCheckService;
  private readonly reservations: ReservationService;
  private readonly invoicings: InvoicingService;
  private readonly receipts: ReceiptService;
  private readonly meterings: MeteringService;
  private readonly now: () => number;
  private readonly destroyContainer?: DestroyContainer;

  constructor(options: BillingServiceOptions = {}) {
    this.accounts = options.accounts ?? accountService;
    this.payments = options.payments ?? paymentService;
    this.prices = options.prices ?? pricingService;
    this.checks = options.checks ?? creditCheckService;
    this.reservations = options.reservations ?? reservationService;
    this.invoicings = options.invoicings ?? invoicingService;
    this.receipts = options.receipts ?? receiptService;
    this.meterings = options.meterings ?? meteringService;
    this.now = options.now ?? (() => Date.now());
    this.destroyContainer = options.destroyContainer;
  }

  /** 容器就绪：统一预扣费检查 → 建预留（保证金+首期）→ 由消费者发布首期结算消息。 */
  async handleContainerReady(event: {
    accountId: string;
    resourceId: string;
    occurredAt: Date;
  }): Promise<{ reservationId: string; insufficient: boolean; nextCycleSeq: number }> {
    const account = await this.accounts.getById(event.accountId);
    if (!account) throw new Error(`billing account not found: ${event.accountId}`);

    const depositCents = config.containerDepositCredits * 100;
    const cycleEstimateCents = Math.max(
      1,
      Math.ceil(config.billingCycleSeconds / 60) * 100,
    );
    const check = await this.checks.check({
      accountId: event.accountId,
      estimatedCredits: depositCents + cycleEstimateCents,
      policy: 'accrue-and-track',
      ref: { type: 'container_reservation', id: event.resourceId },
    });

    const reservation = await this.reservations.start({
      accountId: event.accountId,
      resourceId: event.resourceId,
      startedAt: event.occurredAt,
      depositCents: check.insufficient ? 0 : depositCents,
      cycleEstimateCents: check.insufficient ? 0 : cycleEstimateCents,
      preCheck: check.preCheck!,
    });

    if (check.insufficient) {
      await this.accounts.markInsufficient(event.accountId, new Date(this.now()));
    }
    return {
      reservationId: documentId(reservation),
      insufficient: check.insufficient,
      nextCycleSeq: 0,
    };
  }

  /** 容器销毁：最终结算尾部分钟 + 释放冻结。 */
  async handleContainerDestroyed(event: {
    accountId: string;
    resourceId: string;
    occurredAt: Date;
    payload?: Record<string, unknown>;
  }): Promise<InvoiceResult | null> {
    const reservation = await this.reservations.findByResource(event.resourceId);
    if (!reservation) {
      // 兜底（预留丢失/存量事件）：按事件时长直接出账，保证不漏计。
      return this.billLegacyContainer(event);
    }

    const reservationId = documentId(reservation);
    const result = await this.reservations.finalSettle(reservationId, event.occurredAt);
    if (result.minutes <= 0 || result.amount <= 0) return null;

    const priced = await this.prices.priceContainer(result.minutes, result.windowFrom);
    const metering = await this.ensureMetering({
      eventId: `container:${reservationId}:final`,
      accountId: event.accountId,
      resourceType: 'container',
      resourceId: event.resourceId,
      productId: 'container.minute',
      quantity: result.minutes,
      dims: { minutes: result.minutes, final: true },
      windowFrom: result.windowFrom,
      windowTo: event.occurredAt,
    });

    return this.invoiceExistingCharge({
      accountId: event.accountId,
      amount: result.amount,
      balanceAfter: result.cashBalance,
      category: 'container',
      refType: 'container',
      refId: event.resourceId,
      description: `容器最终结算 ${result.minutes} 分钟`,
      items: priced.items.map((item) => ({ ...item, meteringRef: documentId(metering) })),
      periodFrom: result.windowFrom,
      periodTo: event.occurredAt,
      meteringIds: [documentId(metering)],
    });
  }

  /** 周期结算：本周期已由 ReservationService 解冻/扣费，这里补计量事实 + 账单 + 收据 + 换冻下期。 */
  async handleSettlementCycle(
    reservationId: string,
    cycleSeq: number,
  ): Promise<{ settled: boolean; nextCycleSeq: number; shouldDestroy: boolean; invoice: InvoiceResult | null }> {
    const settlement = await this.reservations.settleCycle(reservationId, cycleSeq);
    if (!settlement.settled) {
      return { settled: false, nextCycleSeq: cycleSeq + 1, shouldDestroy: false, invoice: null };
    }
    const reservation = await this.reservations.findById(reservationId);
    if (!reservation) throw new Error('预留不存在');
    const accountId = String(reservation.accountId);

    const priced = await this.prices.priceContainer(settlement.minutes, settlement.windowFrom);
    const metering = await this.ensureMetering({
      eventId: `container:${reservationId}:cycle:${cycleSeq}`,
      accountId,
      resourceType: 'container',
      resourceId: reservation.resourceId,
      productId: 'container.minute',
      quantity: settlement.minutes,
      dims: { minutes: settlement.minutes, cycleSeq },
      windowFrom: settlement.windowFrom,
      windowTo: settlement.windowTo,
    });
    const invoice =
      settlement.amount > 0
        ? await this.invoiceExistingCharge({
            accountId,
            amount: settlement.amount,
            balanceAfter: settlement.cashBalance,
            category: 'container',
            refType: 'container',
            refId: reservation.resourceId,
            description: `容器周期结算（第 ${cycleSeq + 1} 期，${settlement.minutes} 分钟）`,
            items: priced.items.map((item) => ({ ...item, meteringRef: documentId(metering) })),
            periodFrom: settlement.windowFrom,
            periodTo: settlement.windowTo,
            meteringIds: [documentId(metering)],
          })
        : null;

    await this.reservations.prepareNextCycle(reservationId, cycleSeq + 1);

    // 欠费宽限：连续不足 ≥ 10 分钟 → 强拆该账户全部容器（由调用方执行/本服务回调）。
    const account = await this.accounts.getById(accountId);
    const insufficientSince = account?.insufficientSince;
    const shouldDestroy =
      !!insufficientSince &&
      this.now() - new Date(insufficientSince).getTime() >= config.billingArrearsGraceMs;
    if (shouldDestroy) {
      await this.forceDestroyAccountContainers(accountId);
    }
    return { settled: true, nextCycleSeq: cycleSeq + 1, shouldDestroy, invoice };
  }

  /** 强拆账户下全部容器：先最终结算释放冻结，再调用控制面销毁（释放不被余额阻塞）。 */
  async forceDestroyAccountContainers(accountId: string): Promise<number> {
    const reservations = await this.reservations.list({ accountId, status: 'ACTIVE' });
    let destroyed = 0;
    for (const reservation of reservations) {
      const endedAt = new Date(this.now());
      await this.handleContainerDestroyed({
        accountId,
        resourceId: reservation.resourceId,
        occurredAt: endedAt,
      });
      if (this.destroyContainer) {
        try {
          await this.destroyContainer(reservation.resourceId, CONTAINER_FORCE_DESTROY_REASON);
          destroyed += 1;
        } catch (err) {
          console.warn(
            `[billing] force destroy failed for ${reservation.resourceId}: ${(err as Error).message}`,
          );
        }
      }
    }
    // 计时重置：销毁后从下一个不足周期重新计时
    await BillingAccount.updateOne({ _id: accountId }, { $set: { insufficientSince: null } });
    return destroyed;
  }

  /** 模型调用完成/中断：计量 → 定价 → 扣费 → 账单 → 收据（中断/估算照常扣费）。 */
  async handleModelCallEvent(event: {
    eventId: string;
    eventType: string;
    accountId: string;
    resourceId: string;
    occurredAt: Date;
    payload?: Record<string, unknown>;
  }): Promise<InvoiceResult | null> {
    const billingEvent = await BillingEvent.findOne({ eventId: event.eventId });
    if (!billingEvent) throw new Error(`billing event not found: ${event.eventId}`);
    const metered = await this.meterings.meterEvent(billingEvent);
    if (!metered || !metered.productId) return null;

    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const modelId = String(payload.modelId ?? '');
    const dims = (await MeteringRecord.findOne({ eventId: event.eventId }).lean()) as
      | IMeteringRecord
      | null;
    const usage = {
      inputTokens: Number(dims?.dims?.inputTokens ?? 0),
      cachedInputTokens: Number(dims?.dims?.cachedInputTokens ?? 0),
      outputTokens: Number(dims?.dims?.outputTokens ?? 0),
    };
    const estimated = dims?.estimated === true;
    const priced = await this.prices.priceModel(modelId, usage, event.occurredAt);

    let invoice: InvoiceResult | null = null;
    if (priced.amountCents > 0) {
      const preCheck = await this.checks.check({
        accountId: event.accountId,
        estimatedCredits: priced.amountCents,
        policy: 'accrue-and-track',
        ref: { type: 'model_call', id: event.resourceId },
      });
      invoice = await this.chargeAndInvoice({
        accountId: event.accountId,
        amount: priced.amountCents,
        preCheck: preCheck.preCheck!,
        ref: { type: 'model_call', id: event.resourceId },
        category: 'model',
        refType: 'model_call',
        refId: event.resourceId,
        description: `${estimated ? '模型调用（估算）' : '模型调用'} ${modelId}`,
        items: priced.items.map((item) => ({ ...item, meteringRef: documentId(dims) })),
        idempotentKey: `charge:model:${event.resourceId}`,
        meteringIds: dims ? [documentId(dims)] : [],
      });
    }

    await BillingApiCall.updateOne(
      { requestId: event.resourceId },
      {
        $set: {
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          cost: priced.amountCents,
          status: event.eventType === 'model_call.aborted' ? 'aborted' : 'completed',
          estimated,
          invoiceSeq: invoice?.seq ?? null,
          finishedAt: event.occurredAt,
        },
      },
    );
    return invoice;
  }

  /** 后台充值：入现金池 → 账单 + 收据；充值精度 0.01 credits。 */
  async recharge(input: {
    accountId: string;
    amountCredits: number;
    note?: string;
    operator?: string;
  }): Promise<InvoiceResult> {
    const account = await this.accounts.getById(input.accountId);
    if (!account) throw new Error('账户不存在');
    const amountCents = parseRechargeCents(input.amountCredits);
    const invoiceId = new mongoose.Types.ObjectId();
    const receiptId = new mongoose.Types.ObjectId();
    const idempotentKey = `recharge:${input.accountId}:${invoiceId.toHexString()}`;

    const payment = await this.payments.recharge({
      accountId: input.accountId,
      amountCents,
      idempotentKey,
      bizId: `recharge:${invoiceId.toHexString()}`,
    });
    const note = input.note ? `（${input.note}）` : '';
    const operator = input.operator ? `（操作人：${input.operator}）` : '';
    const invoice = await this.invoicings.createInvoice({
      invoiceId: invoiceId.toHexString(),
      accountId: input.accountId,
      type: 'recharge',
      category: 'manual',
      amount: amountCents,
      balanceAfter: payment.cashBalance,
      refType: 'recharge',
      refId: null,
      description: `后台充值${note}${operator}`,
      items: [],
      receiptId: receiptId.toHexString(),
    });
    const receipt = await this.receipts.issueReceipt({
      receiptId: receiptId.toHexString(),
      invoiceId: invoiceId.toHexString(),
      accountId: input.accountId,
      amount: amountCents,
      balanceAfter: payment.cashBalance,
      seq: invoice.seq,
    });
    return {
      invoiceId: invoiceId.toHexString(),
      seq: invoice.seq,
      receiptNo: receipt.receiptNo,
      balanceAfter: payment.cashBalance,
      amount: amountCents,
    };
  }

  /** 事件入口（MQ 消费者调用）。 */
  async handleEvent(event: {
    eventId: string;
    eventType: string;
    accountId: string;
    resourceId: string;
    occurredAt: Date;
    payload?: Record<string, unknown>;
  }): Promise<unknown> {
    switch (event.eventType) {
      case 'container.ready':
        return this.handleContainerReady(event);
      case 'container.destroyed':
        return this.handleContainerDestroyed(event);
      case 'model_call.completed':
      case 'model_call.aborted':
        return this.handleModelCallEvent(event);
      default:
        return null;
    }
  }

  private async billLegacyContainer(event: {
    accountId: string;
    resourceId: string;
    occurredAt: Date;
    payload?: Record<string, unknown>;
  }): Promise<InvoiceResult | null> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const startedAt = payload.billingStartedAt ? new Date(String(payload.billingStartedAt)) : null;
    if (!startedAt || Number.isNaN(startedAt.getTime())) return null;
    const minutes = ceilMinutes(event.occurredAt.getTime() - startedAt.getTime());
    if (minutes <= 0) return null;
    const priced = await this.prices.priceContainer(minutes, startedAt);
    if (priced.amountCents <= 0) return null;
    const metering = await this.ensureMetering({
      eventId: `container:legacy:${event.resourceId}:${event.occurredAt.toISOString()}`,
      accountId: event.accountId,
      resourceType: 'container',
      resourceId: event.resourceId,
      productId: 'container.minute',
      quantity: minutes,
      dims: { minutes, legacy: true },
      windowFrom: startedAt,
      windowTo: event.occurredAt,
    });
    const preCheck = await this.checks.check({
      accountId: event.accountId,
      estimatedCredits: priced.amountCents,
      policy: 'accrue-and-track',
      ref: { type: 'container_reservation', id: event.resourceId },
    });
    return this.chargeAndInvoice({
      accountId: event.accountId,
      amount: priced.amountCents,
      preCheck: preCheck.preCheck!,
      ref: { type: 'container_reservation', id: event.resourceId },
      category: 'container',
      refType: 'container',
      refId: event.resourceId,
      description: `容器计费 ${minutes} 分钟`,
      items: priced.items.map((item) => ({ ...item, meteringRef: documentId(metering) })),
      idempotentKey: `charge:container:${event.resourceId}:final`,
      periodFrom: startedAt,
      periodTo: event.occurredAt,
      meteringIds: [documentId(metering)],
    });
  }

  private async ensureMetering(input: {
    eventId: string;
    accountId: string;
    resourceType: 'container' | 'model';
    resourceId: string;
    productId: string;
    quantity: number;
    dims: Record<string, unknown>;
    windowFrom: Date;
    windowTo: Date;
  }): Promise<{ _id: unknown }> {
    try {
      return await MeteringRecord.create({
        ...input,
        estimated: false,
        invoiced: false,
        createdAt: new Date(),
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      const existing = await MeteringRecord.findOne({ eventId: input.eventId });
      if (!existing) throw err;
      return existing;
    }
  }

  private async chargeAndInvoice(input: {
    accountId: string;
    amount: number;
    preCheck: PreCheck | string;
    ref: CreditCheckRef;
    category: 'container' | 'model' | 'manual';
    refType: string;
    refId: string | null;
    description: string;
    items: Array<{
      productId: string;
      quantity: number;
      unitPrice: number;
      amount: number;
      meteringRef?: string | null;
      segment?: string | null;
    }>;
    idempotentKey: string;
    releaseFrozenCents?: number;
    periodFrom?: Date | null;
    periodTo?: Date | null;
    meteringIds?: string[];
  }): Promise<InvoiceResult> {
    const invoiceId = new mongoose.Types.ObjectId();
    const receiptId = new mongoose.Types.ObjectId();
    const payment = await this.payments.charge({
      accountId: input.accountId,
      amountCents: input.amount,
      idempotentKey: input.idempotentKey,
      bizId: invoiceId.toHexString(),
      invoiceId: invoiceId.toHexString(),
      releaseFrozenCents: input.releaseFrozenCents,
      preCheck: input.preCheck,
      ref: input.ref,
      pool: await this.resolvePool(input.accountId, input.amount),
    });

    // 幂等重放：返回已存在的账单
    if (!payment.applied) {
      const existing = await BillingInvoice.findOne({
        accountId: input.accountId,
        refId: input.refId,
        description: input.description,
      }).sort({ createdAt: -1 });
      if (existing) {
        return {
          invoiceId: documentId(existing),
          seq: existing.seq,
          receiptNo: '',
          balanceAfter: existing.balanceAfter,
          amount: input.amount,
        };
      }
    }

    const invoice = await this.invoicings.createInvoice({
      invoiceId: invoiceId.toHexString(),
      accountId: input.accountId,
      type: 'charge',
      category: input.category,
      amount: -input.amount,
      balanceAfter: payment.cashBalance,
      refType: input.refType,
      refId: input.refId,
      description: input.description,
      items: input.items,
      receiptId: receiptId.toHexString(),
      periodFrom: input.periodFrom ?? null,
      periodTo: input.periodTo ?? null,
    });
    const receipt = await this.receipts.issueReceipt({
      receiptId: receiptId.toHexString(),
      invoiceId: invoiceId.toHexString(),
      accountId: input.accountId,
      amount: input.amount,
      balanceAfter: payment.cashBalance,
      seq: invoice.seq,
    });
    if (input.meteringIds?.length) {
      await MeteringRecord.updateMany(
        { _id: { $in: input.meteringIds } },
        { $set: { invoiced: true } },
      );
    }
    return {
      invoiceId: invoiceId.toHexString(),
      seq: invoice.seq,
      receiptNo: receipt.receiptNo,
      balanceAfter: payment.cashBalance,
      amount: input.amount,
    };
  }

  private async invoiceExistingCharge(input: {
    accountId: string;
    amount: number;
    balanceAfter: number;
    category: 'container' | 'model' | 'manual';
    refType: string;
    refId: string | null;
    description: string;
    items: Array<{
      productId: string;
      quantity: number;
      unitPrice: number;
      amount: number;
      meteringRef?: string | null;
      segment?: string | null;
    }>;
    periodFrom?: Date | null;
    periodTo?: Date | null;
    meteringIds?: string[];
  }): Promise<InvoiceResult> {
    const invoiceId = new mongoose.Types.ObjectId();
    const receiptId = new mongoose.Types.ObjectId();
    const invoice = await this.invoicings.createInvoice({
      invoiceId: invoiceId.toHexString(),
      accountId: input.accountId,
      type: 'charge',
      category: input.category,
      amount: -input.amount,
      balanceAfter: input.balanceAfter,
      refType: input.refType,
      refId: input.refId,
      description: input.description,
      items: input.items,
      receiptId: receiptId.toHexString(),
      periodFrom: input.periodFrom ?? null,
      periodTo: input.periodTo ?? null,
    });
    const receipt = await this.receipts.issueReceipt({
      receiptId: receiptId.toHexString(),
      invoiceId: invoiceId.toHexString(),
      accountId: input.accountId,
      amount: input.amount,
      balanceAfter: input.balanceAfter,
      seq: invoice.seq,
    });
    if (input.meteringIds?.length) {
      await MeteringRecord.updateMany(
        { _id: { $in: input.meteringIds } },
        { $set: { invoiced: true } },
      );
    }
    return {
      invoiceId: invoiceId.toHexString(),
      seq: invoice.seq,
      receiptNo: receipt.receiptNo,
      balanceAfter: input.balanceAfter,
      amount: input.amount,
    };
  }

  private async resolvePool(accountId: string, amount: number): Promise<'cash' | 'gift' | 'credit'> {
    if (!mongoose.isValidObjectId(accountId)) return 'cash';
    const account = await BillingAccount.findById(accountId).lean();
    if (!account) return 'cash';
    if (availableCents(account) - amount >= 0) return 'cash';
    if ((account.creditLimit ?? 0) > 0) return 'credit';
    return 'cash';
  }
}

export const billingService = new BillingService();
