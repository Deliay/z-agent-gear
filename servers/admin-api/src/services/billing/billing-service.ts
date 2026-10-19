import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { config } from '../../config/index.js';
import { BillingAccount } from '../../models/billing-account.js';
import { BillingApiCall } from '../../models/billing-api-call.js';
import { BillingEvent } from '../../models/billing-event.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { BillingLedger } from '../../models/billing-ledger.js';
import { MeteringRecord, type IMeteringRecord } from '../../models/metering-record.js';
import { accountService, type AccountService } from './account-service.js';
import {
  creditCheckService,
  type CreditCheckRef,
  type CreditCheckService,
  type PreCheck,
} from './credit-check.js';
import { billingMutex } from './keyed-mutex.js';
import { InvoicingService, invoicingService } from './invoicing.js';
import { documentId } from './id.js';
import { availableCents, ceilMinutes, parseRechargeCents } from './money.js';
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

/** 由业务键派生确定性 ObjectId：重放/并发写入同一账单，唯一索引兜底。 */
export function deterministicObjectId(seed: string): string {
  return crypto.createHash('md5').update(seed).digest('hex').slice(0, 24);
}

/**
 * 计费管线编排（事件 → 计量 → 定价 → 账单 → 支付 → 收据）。
 * 所有 reservation 级入口经 billingMutex 串行；资金/账单均带幂等键，可重入。
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

  /** 容器就绪：统一预扣费检查 → 建预留（保证金+首期）。 */
  async handleContainerReady(event: {
    accountId: string;
    resourceId: string;
    occurredAt: Date;
  }): Promise<{
    reservationId: string;
    insufficient: boolean;
    nextCycleSeq: number;
    created: boolean;
    /** R-1：乱序门控命中（该资源已有终结事实/legacy 计费），本次就绪不建预留、不启动结算链。 */
    skipped?: boolean;
  }> {
    return billingMutex.runExclusive(`container:${event.resourceId}`, async () => {
      const account = await this.accounts.getById(event.accountId);
      if (!account) throw new Error(`billing account not found: ${event.accountId}`);

      // 门控重复投递（阻塞项 3）：同一 resourceId 已有预留行时为重复就绪事件，
      // `created=false` 时消费端不再重复投递首期延迟消息，避免结算链放大。
      const existing = await this.reservations.findByResource(event.resourceId);

      // R-1（乱序安全）：destroyed 可能先于 ready 被消费（outbox 单条失败后重连翻转顺序、
      // 多副本认领租约过期等）。一旦该资源已摄入 destroyed 事实或已按 legacy 全额开票，
      // 迟到的 ready **绝不能再建预留**（否则 legacy 全额 + 周期结算 + 最终结算三族幂等键
      // 互不去重，同一会话被计 2~3 次）。
      if (existing && existing.status !== 'PENDING') {
        return {
          reservationId: documentId(existing),
          insufficient: false,
          nextCycleSeq: 0,
          created: false,
        };
      }
      const destroyed = await BillingEvent.exists({
        resourceId: event.resourceId,
        eventType: 'container.destroyed',
      });
      const legacyCharged = await BillingLedger.exists({
        idempotentKey: `charge:container:${event.resourceId}:final`,
      });
      if (destroyed || legacyCharged) {
        return {
          reservationId: existing ? documentId(existing) : '',
          insufficient: false,
          nextCycleSeq: 0,
          created: false,
          skipped: true,
        };
      }

      const depositCents = config.containerDepositCredits * 100;
      // A9：周期冻结估算按价格表实际单价计算，而非硬编码 1 credit/分钟（避免定价更高时冻结不足）。
      const cycleMinutes = Math.max(1, Math.ceil(config.billingCycleSeconds / 60));
      const cyclePriced = await this.prices.priceContainer(cycleMinutes, event.occurredAt);
      const cycleEstimateCents = Math.max(1, cyclePriced.amountCents);
      const check = await this.checks.check({
        accountId: event.accountId,
        estimatedCredits: depositCents + cycleEstimateCents,
        policy: 'accrue-and-track',
        // 与 ReservationService.start / payment.freeze 使用同一 ref（resourceId），避免凭证 ref 不匹配
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
        created: !existing,
      };
    });
  }

  /** 容器销毁：最终结算尾部分钟 + 释放冻结（幂等，可并发安全）。 */
  async handleContainerDestroyed(event: {
    accountId: string;
    resourceId: string;
    occurredAt: Date;
    payload?: Record<string, unknown>;
  }): Promise<InvoiceResult | null> {
    // R-1：ready/destroyed 用同一把 `container:{resourceId}` 锁串行化，并在锁内**重新读取**预留。
    // 若只在锁外读一次，会出现「ready 正在建预留、destroyed 读到空 → legacy 全额开票」的竞态。
    return billingMutex.runExclusive(`container:${event.resourceId}`, async () => {
      const reservation = await this.reservations.findByResource(event.resourceId);
      if (!reservation) {
        return this.billLegacyContainer(event);
      }
      return this.finalizeReservation(reservation, event);
    });
  }

  /** 预留维度终结（与周期结算共用 `reservation:{id}` 锁）。 */
  private async finalizeReservation(
    reservation: NonNullable<Awaited<ReturnType<ReservationService['findByResource']>>>,
    event: {
      accountId: string;
      resourceId: string;
      occurredAt: Date;
      payload?: Record<string, unknown>;
    },
  ): Promise<InvoiceResult | null> {
    const reservationId = documentId(reservation);
    return billingMutex.runExclusive(`reservation:${reservationId}`, async () => {
      const result = await this.reservations.finalSettle(reservationId, event.occurredAt);
      if (result.minutes <= 0 || result.amount <= 0) return null;

      const priced = await this.prices.priceContainer(result.minutes, result.windowFrom);
      const billKey = result.tail
        ? `invoice:container-final-gap:${reservationId}:${result.windowFrom.getTime()}`
        : `invoice:container-final:${reservationId}`;
      const eventKey = result.tail
        ? `container:${reservationId}:final-gap:${result.windowFrom.getTime()}`
        : `container:${reservationId}:final`;
      const metering = await this.ensureMetering({
        eventId: eventKey,
        accountId: event.accountId,
        resourceType: 'container',
        resourceId: event.resourceId,
        productId: 'container.minute',
        quantity: result.minutes,
        dims: { minutes: result.minutes, final: true, ...(result.tail ? { gap: true } : {}) },
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
        description: result.tail
          ? `容器缺额补结 ${result.minutes} 分钟（最终结算后仍有运行）`
          : `容器最终结算 ${result.minutes} 分钟`,
        items: priced.items.map((item) => ({ ...item, meteringRef: String(metering._id) })),
        periodFrom: result.windowFrom,
        periodTo: event.occurredAt,
        meteringIds: [String(metering._id)],
        idempotentKey: billKey,
        invoiceId: deterministicObjectId(billKey),
      });
    });
  }

  /** 周期结算：补计量事实 + 账单 + 收据 + 换冻下期（账单幂等键保证重放不重复开票）。 */
  async handleSettlementCycle(
    reservationId: string,
    cycleSeq: number,
  ): Promise<{
    settled: boolean;
    nextCycleSeq: number;
    shouldDestroy: boolean;
    invoice: InvoiceResult | null;
  }> {
    const outcome = await billingMutex.runExclusive(`reservation:${reservationId}`, async () => {
      // R-1：destroyed 先到且已走 legacy 计费的资源没有预留；迟到的结算消息直接 no-op，
      // 不再抛错触发 MQ 重试/DLQ 噪声。
      const reservationBefore = await this.reservations.findById(reservationId);
      if (!reservationBefore) {
        return {
          settled: false,
          nextCycleSeq: cycleSeq + 1,
          shouldDestroy: false,
          invoice: null,
          accountId: null as string | null,
        };
      }
      const settlement = await this.reservations.settleCycle(reservationId, cycleSeq);
      if (!settlement.settled) {
        return {
          settled: false,
          nextCycleSeq: cycleSeq + 1,
          shouldDestroy: false,
          invoice: null,
          accountId: null as string | null,
        };
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
              items: priced.items.map((item) => ({ ...item, meteringRef: String(metering._id) })),
              periodFrom: settlement.windowFrom,
              periodTo: settlement.windowTo,
              meteringIds: [String(metering._id)],
              idempotentKey: `invoice:container-cycle:${reservationId}:${cycleSeq}`,
              invoiceId: deterministicObjectId(
                `invoice:container-cycle:${reservationId}:${cycleSeq}`,
              ),
            })
          : null;

      await this.reservations.prepareNextCycle(reservationId, cycleSeq + 1);

      const account = await this.accounts.getById(accountId);
      const insufficientSince = account?.insufficientSince;
      const shouldDestroy =
        !!insufficientSince &&
        this.now() - new Date(insufficientSince).getTime() >= config.billingArrearsGraceMs;
      return {
        settled: true,
        nextCycleSeq: cycleSeq + 1,
        shouldDestroy,
        invoice,
        accountId,
      };
    });

    // 强拆在锁外执行：forceDestroy 内部会对同一预留再次加锁（KeyedMutex 不可重入）
    if (outcome.shouldDestroy && outcome.accountId) {
      await this.forceDestroyAccountContainers(outcome.accountId);
    }
    return {
      settled: outcome.settled,
      nextCycleSeq: outcome.nextCycleSeq,
      shouldDestroy: outcome.shouldDestroy,
      invoice: outcome.invoice,
    };
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
    return billingMutex.runExclusive(`model:${event.resourceId}`, async () => {
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
      const aborted = event.eventType === 'model_call.aborted';
      const abortReason =
        typeof payload.reason === 'string' && payload.reason.length > 0 ? payload.reason : '调用中断';
      const priced = await this.prices.priceModel(modelId, usage, event.occurredAt);
      const description = aborted
        ? `模型调用（中断：${abortReason}${estimated ? '，估算' : ''}） ${modelId}`
        : `${estimated ? '模型调用（估算）' : '模型调用'} ${modelId}`;

      let invoice: InvoiceResult | null = null;
      if (priced.amountCents === 0) {
        // A8/R2-4：无生效价目或**价目档全 0** 都会让 amountCents=0、消费免费消失；
        // 显式区分告警以便补价（对账线 apiCalls 亦会兜底报告 cost/invoice 不一致）。
        const rates = priced.snapshot?.rates;
        const zeroRates =
          !!rates &&
          rates.inputPerMillion === 0 &&
          rates.cachedInputPerMillion === 0 &&
          rates.outputPerMillion === 0;
        console.warn(
          `[billing] model ${modelId} ${zeroRates ? 'has all-zero effective price row' : 'has no effective price row'}; charge skipped (eventId=${event.eventId})`,
        );
      }
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
          description,
          items: priced.items.map((item) => ({
            ...item,
            meteringRef: documentId(dims),
            segment: aborted ? `${item.segment ?? 'output'}:aborted` : item.segment,
          })),
          idempotentKey: `charge:model:${event.resourceId}`,
          invoiceKey: `invoice:model:${event.resourceId}`,
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
    });
  }

  /** 后台充值：入现金池 → 账单 + 收据；充值精度 0.01 credits。 */
  async recharge(input: {
    accountId: string;
    amountCredits: number;
    note?: string;
    operator?: string;
    /** A5：调用方幂等键（重试/双击使用同一键则不重复加钱）。 */
    idempotencyKey?: string;
  }): Promise<InvoiceResult> {
    const account = await this.accounts.getById(input.accountId);
    if (!account) throw new Error('账户不存在');
    const amountCents = parseRechargeCents(input.amountCredits);
    // A5：提供幂等键时由业务键派生确定性账单/收据 ID，重放返回同一结果；未提供时退化为唯一 ID。
    const opKey = input.idempotencyKey?.trim();
    const invoiceHex = opKey
      ? deterministicObjectId(`recharge-invoice:${input.accountId}:${opKey}`)
      : new mongoose.Types.ObjectId().toHexString();
    const receiptHex = opKey
      ? deterministicObjectId(`recharge-receipt:${input.accountId}:${opKey}`)
      : new mongoose.Types.ObjectId().toHexString();
    const idempotentKey = opKey
      ? `recharge:${input.accountId}:${opKey}`
      : `recharge:${input.accountId}:${invoiceHex}`;

    const payment = await this.payments.recharge({
      accountId: input.accountId,
      amountCents,
      idempotentKey,
      bizId: `recharge:${invoiceHex}`,
    });
    const note = input.note ? `（${input.note}）` : '';
    const operator = input.operator ? `（操作人：${input.operator}）` : '';
    const invoice = await this.invoicings.createInvoice({
      invoiceId: invoiceHex,
      idempotentKey: `invoice:${idempotentKey}`,
      accountId: input.accountId,
      type: 'recharge',
      category: 'manual',
      amount: amountCents,
      balanceAfter: payment.cashBalance,
      refType: 'recharge',
      refId: null,
      description: `后台充值${note}${operator}`,
      items: [],
      receiptId: receiptHex,
    });
    const receipt = await this.receipts.issueReceipt({
      receiptId: receiptHex,
      invoiceId: invoiceHex,
      accountId: input.accountId,
      amount: amountCents,
      balanceAfter: payment.cashBalance,
      seq: invoice.seq,
    });
    return {
      invoiceId: invoiceHex,
      seq: invoice.seq,
      receiptNo: receipt.receiptNo,
      balanceAfter: payment.cashBalance,
      amount: amountCents,
    };
  }

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
      items: priced.items.map((item) => ({ ...item, meteringRef: String(metering._id) })),
      idempotentKey: `charge:container:${event.resourceId}:final`,
      invoiceKey: `invoice:container:${event.resourceId}:final`,
      periodFrom: startedAt,
      periodTo: event.occurredAt,
      meteringIds: [String(metering._id)],
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
    invoiceKey: string;
    releaseFrozenCents?: number;
    periodFrom?: Date | null;
    periodTo?: Date | null;
    meteringIds?: string[];
  }): Promise<InvoiceResult> {
    const invoiceId = deterministicObjectId(input.invoiceKey);
    const receiptId = deterministicObjectId(`receipt:${input.invoiceKey}`);
    const payment = await this.payments.charge({
      accountId: input.accountId,
      amountCents: input.amount,
      idempotentKey: input.idempotentKey,
      bizId: invoiceId,
      invoiceId,
      releaseFrozenCents: input.releaseFrozenCents,
      preCheck: input.preCheck,
      ref: input.ref,
      pool: await this.resolvePool(input.accountId, input.amount),
    });

    const invoice = await this.invoicings.createInvoice({
      invoiceId,
      idempotentKey: input.invoiceKey,
      accountId: input.accountId,
      type: 'charge',
      category: input.category,
      amount: -input.amount,
      balanceAfter: payment.cashBalance,
      refType: input.refType,
      refId: input.refId,
      description: input.description,
      items: input.items,
      receiptId,
      periodFrom: input.periodFrom ?? null,
      periodTo: input.periodTo ?? null,
    });
    const receipt = await this.receipts.issueReceipt({
      receiptId,
      invoiceId,
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
      invoiceId,
      seq: invoice.seq,
      receiptNo: receipt.receiptNo,
      balanceAfter: payment.cashBalance,
      amount: input.amount,
    };
  }

  /** 结算阶段已完成扣费，仅补账单 + 收据（两者均幂等）。 */
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
    idempotentKey: string;
    invoiceId: string;
  }): Promise<InvoiceResult> {
    const receiptId = deterministicObjectId(`receipt:${input.idempotentKey}`);
    const invoice = await this.invoicings.createInvoice({
      invoiceId: input.invoiceId,
      idempotentKey: input.idempotentKey,
      accountId: input.accountId,
      type: 'charge',
      category: input.category,
      amount: -input.amount,
      balanceAfter: input.balanceAfter,
      refType: input.refType,
      refId: input.refId,
      description: input.description,
      items: input.items,
      receiptId,
      periodFrom: input.periodFrom ?? null,
      periodTo: input.periodTo ?? null,
    });
    const receipt = await this.receipts.issueReceipt({
      receiptId,
      invoiceId: input.invoiceId,
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
      invoiceId: input.invoiceId,
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
    if ((account.giftBalance ?? 0) > 0 && availableCents(account) - amount < 0) return 'gift';
    if (availableCents(account) - amount >= 0) return 'cash';
    return (account.creditLimit ?? 0) > 0 ? 'credit' : 'cash';
  }
}

export const billingService = new BillingService();
