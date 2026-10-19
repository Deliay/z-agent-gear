import mongoose from 'mongoose';
import { config } from '../../config/index.js';
import { BillingLedger } from '../../models/billing-ledger.js';
import {
  BillingReservation,
  BillingReservationCycle,
  type IBillingReservation,
} from '../../models/billing-reservation.js';
import { accountService, type AccountService } from './account-service.js';
import { CreditCheckService, creditCheckService, type PreCheck } from './credit-check.js';
import { documentId } from './id.js';
import { ceilMinutes } from './money.js';
import { PaymentService, paymentService } from './payment.js';
import { PricingService, pricingService } from './pricing.js';

export interface StartReservationInput {
  accountId: string;
  resourceId: string;
  startedAt: Date;
  depositCents: number;
  cycleEstimateCents: number;
  preCheck: PreCheck | string;
}

export interface CycleSettlement {
  settled: boolean;
  cycleSeq: number;
  minutes: number;
  amount: number;
  windowFrom: Date;
  windowTo: Date;
  cashBalance: number;
}

export interface ReservationServiceOptions {
  cycleMs?: number;
  now?: () => number;
}

function reservationBizPrefix(reservationId: string): string {
  return `reservation:${reservationId}:`;
}

/**
 * 预留状态机 `PENDING→ACTIVE→SETTLING→SETTLED`（+`RELEASE_PENDING`）：
 * 保证金 + 周期实扣。资金动作全部用支付层幂等键，因此结算器可重入、故障恢复 = 重跑；
 * 周期记录仅作为「已完成」结果标记（写入在资金动作之后），不作为先决闸门。
 */
export class ReservationService {
  private readonly cycleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly payments: PaymentService = paymentService,
    private readonly prices: PricingService = pricingService,
    private readonly checks: CreditCheckService = creditCheckService,
    private readonly accounts: AccountService = accountService,
    options: ReservationServiceOptions = {},
  ) {
    this.cycleMs = options.cycleMs ?? config.billingCycleSeconds * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  async findActiveByResource(resourceId: string): Promise<IBillingReservation | null> {
    return BillingReservation.findOne({ resourceId, status: 'ACTIVE' });
  }

  async findByResource(resourceId: string): Promise<IBillingReservation | null> {
    return BillingReservation.findOne({ resourceId }).sort({ createdAt: -1 });
  }

  async findById(reservationId: string): Promise<IBillingReservation | null> {
    if (!mongoose.isValidObjectId(reservationId)) return null;
    return BillingReservation.findById(reservationId);
  }

  async list(filter: { accountId?: string; status?: string } = {}): Promise<IBillingReservation[]> {
    const query: Record<string, unknown> = {};
    if (filter.accountId) query.accountId = filter.accountId;
    if (filter.status) query.status = filter.status;
    return BillingReservation.find(query).sort({ createdAt: -1 }).limit(500);
  }

  /** 就绪：建预留 → 冻结保证金 → 冻结首期预估 → ACTIVE。并发由 resourceId 唯一索引兜底。 */
  async start(input: StartReservationInput): Promise<IBillingReservation> {
    let reservation: IBillingReservation | null = null;
    try {
      reservation = await BillingReservation.create({
        accountId: input.accountId,
        resourceId: input.resourceId,
        resourceType: 'container',
        productId: 'container.minute',
        status: 'PENDING',
        depositCents: input.depositCents,
        cycleEstimateCents: input.cycleEstimateCents,
        reservedTotal: 0,
        settledTotal: 0,
        releasedTotal: 0,
        lastSettleAt: input.startedAt,
        lastCycleSeq: -1,
        startedAt: input.startedAt,
        expectedEndAt: new Date(input.startedAt.getTime() + 2 * this.cycleMs),
        version: 0,
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      const existing = await this.findByResource(input.resourceId);
      if (existing) return existing;
      throw err;
    }

    const reservationId = documentId(reservation);
    const ref = { type: 'container_reservation' as const, id: input.resourceId };
    if (input.depositCents > 0) {
      await this.payments.freeze({
        accountId: input.accountId,
        amountCents: input.depositCents,
        bizId: `${reservationBizPrefix(reservationId)}deposit`,
        idempotentKey: `freeze:deposit:${reservationId}`,
        preCheck: input.preCheck,
        ref,
      });
    }
    if (input.cycleEstimateCents > 0) {
      await this.payments.freeze({
        accountId: input.accountId,
        amountCents: input.cycleEstimateCents,
        bizId: `${reservationBizPrefix(reservationId)}cycle:0`,
        idempotentKey: `freeze:cycle:${reservationId}:0`,
        preCheck: input.preCheck,
        ref,
      });
    }
    await this.recomputeTotals(reservationId, input.accountId);
    const activated = await BillingReservation.findOneAndUpdate(
      { _id: reservationId, status: 'PENDING' },
      { $set: { status: 'ACTIVE' }, $inc: { version: 1 } },
      { new: true },
    );
    return activated ?? (await BillingReservation.findById(reservationId))!;
  }

  /**
   * 周期结算：本期分钟 → 定价 → 解冻本期预估（仅当对应 freeze 存在）→ 扣费（余额不足允许为负）。
   * 资金动作幂等，重复消息/故障重跑安全；周期记录在动作完成后写入（结果标记）。
   */
  async settleCycle(reservationId: string, cycleSeq: number): Promise<CycleSettlement> {
    const reservation = await this.findById(reservationId);
    if (!reservation) throw new Error('预留不存在');
    if (reservation.status !== 'ACTIVE') {
      return {
        settled: false,
        cycleSeq,
        minutes: 0,
        amount: 0,
        windowFrom: reservation.startedAt,
        windowTo: reservation.startedAt,
        cashBalance: 0,
      };
    }

    const windowFrom = new Date(reservation.startedAt.getTime() + cycleSeq * this.cycleMs);
    const windowTo = new Date(windowFrom.getTime() + this.cycleMs);
    const settleTo =
      reservation.expectedEndAt && reservation.expectedEndAt < windowTo
        ? reservation.expectedEndAt
        : windowTo;

    if (settleTo.getTime() > this.now()) {
      return {
        settled: false,
        cycleSeq,
        minutes: 0,
        amount: 0,
        windowFrom,
        windowTo,
        cashBalance: 0,
      };
    }

    const minutes = Math.max(1, ceilMinutes(settleTo.getTime() - windowFrom.getTime()));
    const priced = await this.prices.priceContainer(minutes, windowFrom);
    const accountId = String(reservation.accountId);

    // 仅当该周期确实冻结过才解冻，避免欠费周期无冻结却释放、蚕食保证金
    const freezeKey = `freeze:cycle:${reservationId}:${cycleSeq}`;
    const freezeExists = await BillingLedger.exists({ idempotentKey: freezeKey });
    if (freezeExists && reservation.cycleEstimateCents > 0) {
      await this.payments.unfreeze({
        accountId,
        amountCents: reservation.cycleEstimateCents,
        bizId: `${reservationBizPrefix(reservationId)}cycle:${cycleSeq}`,
        idempotentKey: `unfreeze:cycle:${reservationId}:${cycleSeq}`,
      });
    }

    const preCheck = await this.checks.check({
      accountId,
      estimatedCredits: priced.amountCents,
      policy: 'accrue-and-track',
      ref: { type: 'container_reservation', id: reservationId },
    });
    const payment = await this.payments.charge({
      accountId,
      amountCents: priced.amountCents,
      idempotentKey: `charge:cycle:${reservationId}:${cycleSeq}`,
      bizId: `${reservationBizPrefix(reservationId)}cycle:${cycleSeq}`,
      preCheck: preCheck.preCheck!,
      ref: { type: 'container_reservation', id: reservationId },
    });

    await BillingReservationCycle.updateOne(
      { reservationId: new mongoose.Types.ObjectId(reservationId), cycleSeq },
      {
        $set: {
          windowFrom,
          windowTo: settleTo,
          minutes,
          amount: priced.amountCents,
          status: 'settled',
        },
        $setOnInsert: { reservationId: new mongoose.Types.ObjectId(reservationId), cycleSeq, createdAt: new Date() },
      },
      { upsert: true },
    );

    await BillingReservation.updateOne(
      { _id: reservationId },
      [
        {
          $set: {
            lastSettleAt: {
              $cond: [{ $gt: ['$lastSettleAt', settleTo] }, '$lastSettleAt', settleTo],
            },
            lastCycleSeq: {
              $max: [{ $ifNull: ['$lastCycleSeq', -1] }, cycleSeq],
            },
            expectedEndAt: new Date(settleTo.getTime() + 2 * this.cycleMs),
            status: 'ACTIVE',
            version: { $add: [{ $ifNull: ['$version', 0] }, 1] },
          },
        },
      ],
      { updatePipeline: true } as never,
    );
    await this.recomputeTotals(reservationId, accountId);

    const settledAccount = await this.accounts.getById(accountId);
    if (!settledAccount || settledAccount.availableBalance < 0) {
      await this.accounts.markInsufficient(accountId, new Date(this.now()));
    } else {
      await this.accounts.clearInsufficient(accountId);
    }

    return {
      settled: true,
      cycleSeq,
      minutes,
      amount: priced.amountCents,
      windowFrom,
      windowTo: settleTo,
      cashBalance: payment.cashBalance,
    };
  }

  /** 下一期换冻：accrue-and-track 预检后重冻下一期预估；余额不足不阻断计费。 */
  async prepareNextCycle(
    reservationId: string,
    nextSeq: number,
  ): Promise<{ frozen: boolean; insufficient: boolean }> {
    const reservation = await this.findById(reservationId);
    if (!reservation || reservation.status !== 'ACTIVE') {
      return { frozen: false, insufficient: false };
    }
    const estimate = reservation.cycleEstimateCents;
    if (estimate <= 0) return { frozen: true, insufficient: false };

    const accountId = String(reservation.accountId);
    const check = await this.checks.check({
      accountId,
      estimatedCredits: estimate,
      policy: 'accrue-and-track',
      ref: { type: 'container_reservation', id: reservationId },
    });
    if (check.insufficient) {
      await this.accounts.markInsufficient(accountId, new Date(this.now()));
      return { frozen: false, insufficient: true };
    }

    await this.payments.freeze({
      accountId,
      amountCents: estimate,
      bizId: `${reservationBizPrefix(reservationId)}cycle:${nextSeq}`,
      idempotentKey: `freeze:cycle:${reservationId}:${nextSeq}`,
      preCheck: check.preCheck!,
      ref: { type: 'container_reservation', id: reservationId },
    });
    await this.recomputeTotals(reservationId, accountId);
    await this.accounts.clearInsufficient(accountId);
    return { frozen: true, insufficient: false };
  }

  /** 最终结算：结清尾部分钟 + 释放全部剩余冻结（不阻塞资源释放）。 */
  async finalSettle(
    reservationId: string,
    endedAt: Date,
  ): Promise<{ minutes: number; amount: number; cashBalance: number; windowFrom: Date }> {
    const reservation = await this.findById(reservationId);
    if (!reservation) {
      return { minutes: 0, amount: 0, cashBalance: 0, windowFrom: endedAt };
    }
    const accountId = String(reservation.accountId);
    const from = reservation.lastSettleAt ?? reservation.startedAt;
    const minutes = ceilMinutes(endedAt.getTime() - from.getTime());
    let amount = 0;
    let cashBalance = 0;

    // 版本 CAS 抢占最终结算（SETTLING）；并发/重放时仅一个请求执行扣费，其余按幂等键 no-op。
    const claimed = await BillingReservation.findOneAndUpdate(
      { _id: reservationId, status: { $in: ['ACTIVE', 'PENDING'] }, version: reservation.version },
      { $set: { status: 'SETTLING' }, $inc: { version: 1 } },
      { new: true },
    );
    if (!claimed) {
      const latest = await this.findById(reservationId);
      if (!latest || latest.status === 'SETTLED') {
        return { minutes: 0, amount: 0, cashBalance: 0, windowFrom: from };
      }
    }

    if (minutes > 0) {
      const priced = await this.prices.priceContainer(minutes, from);
      amount = priced.amountCents;
      const preCheck = await this.checks.check({
        accountId,
        estimatedCredits: amount,
        policy: 'accrue-and-track',
        ref: { type: 'container_reservation', id: reservationId },
      });
      const payment = await this.payments.charge({
        accountId,
        amountCents: amount,
        idempotentKey: `charge:final:${reservationId}`,
        bizId: `${reservationBizPrefix(reservationId)}final`,
        preCheck: preCheck.preCheck!,
        ref: { type: 'container_reservation', id: reservationId },
      });
      cashBalance = payment.cashBalance;
    }

    // 当前仍被该预留占用的冻结额（以 ledger 为准，重复执行时自然为 0）
    const held = await this.heldFrozen(reservationId);
    await BillingReservation.updateOne(
      { _id: reservationId },
      { $set: { status: 'RELEASE_PENDING' }, $inc: { version: 1 } },
    );
    if (held > 0) {
      await this.payments.unfreeze({
        accountId,
        amountCents: held,
        bizId: `${reservationBizPrefix(reservationId)}final-release`,
        idempotentKey: `unfreeze:final:${reservationId}`,
      });
    }
    await BillingReservation.updateOne(
      { _id: reservationId },
      {
        $set: {
          status: 'SETTLED',
          lastSettleAt: endedAt,
          expectedEndAt: endedAt,
        },
        $inc: { version: 1 },
      },
    );
    await this.recomputeTotals(reservationId, accountId);

    const account = await this.accounts.getById(accountId);
    if (!account || account.availableBalance < 0) {
      await this.accounts.markInsufficient(accountId, new Date(this.now()));
    } else {
      await this.accounts.clearInsufficient(accountId);
    }
    return { minutes, amount, cashBalance, windowFrom: from };
  }

  /** 预留当前占用的冻结额（ledger 合计）。 */
  async heldFrozen(reservationId: string): Promise<number> {
    const rows = (await BillingLedger.aggregate([
      {
        $match: {
          bizId: { $regex: `^reservation:${reservationId}:` },
        },
      },
      { $group: { _id: null, frozen: { $sum: '$deltaFrozen' } } },
    ])) as Array<{ frozen: number }>;
    return Math.max(0, Math.round(rows[0]?.frozen ?? 0));
  }

  /** 预留累计口径以 ledger 为准重算（幂等，供展示与对账）。 */
  async recomputeTotals(reservationId: string, accountId: string): Promise<void> {
    const rows = (await BillingLedger.aggregate([
      { $match: { accountId: new mongoose.Types.ObjectId(accountId), bizId: { $regex: `^reservation:${reservationId}:` } } },
      {
        $group: {
          _id: null,
          frozen: { $sum: '$deltaFrozen' },
          charged: {
            $sum: { $cond: [{ $eq: ['$bizType', 'charge'] }, '$deltaBalance', 0] },
          },
          released: {
            $sum: { $cond: [{ $eq: ['$bizType', 'unfreeze'] }, { $multiply: ['$deltaFrozen', -1] }, 0] },
          },
        },
      },
    ])) as Array<{ frozen: number; charged: number; released: number }>;
    const held = Math.max(0, Math.round(rows[0]?.frozen ?? 0));
    const released = Math.max(0, Math.round(rows[0]?.released ?? 0));
    const settled = Math.max(0, -Math.round(rows[0]?.charged ?? 0));
    await BillingReservation.updateOne(
      { _id: reservationId },
      {
        $set: {
          reservedTotal: held + released,
          settledTotal: settled,
          releasedTotal: released,
        },
      },
    );
  }
}

export const reservationService = new ReservationService();
