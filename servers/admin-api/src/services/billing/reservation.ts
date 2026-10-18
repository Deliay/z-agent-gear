import mongoose from 'mongoose';
import {
  BillingReservation,
  BillingReservationCycle,
  type IBillingReservation,
} from '../../models/billing-reservation.js';
import { accountService, type AccountService } from './account-service.js';
import { CreditCheckService, creditCheckService, type PreCheck } from './credit-check.js';
import { ceilMinutes } from './money.js';
import { documentId } from './id.js';
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

/**
 * 预留状态机 `PENDING→ACTIVE→SETTLING→SETTLED`（+`RELEASE_PENDING`）：
 * 保证金 + 周期实扣；`(reservationId, cycleSeq)` 唯一保证重复消息无副作用。
 */
export class ReservationService {
  constructor(
    private readonly payments: PaymentService = paymentService,
    private readonly prices: PricingService = pricingService,
    private readonly checks: CreditCheckService = creditCheckService,
    private readonly accounts: AccountService = accountService,
    private readonly now: () => number = () => Date.now(),
  ) {}

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

  async list(filter: {
    accountId?: string;
    status?: string;
  } = {}): Promise<IBillingReservation[]> {
    const query: Record<string, unknown> = {};
    if (filter.accountId) query.accountId = filter.accountId;
    if (filter.status) query.status = filter.status;
    return BillingReservation.find(query).sort({ createdAt: -1 }).limit(500);
  }

  /** 就绪：建预留 → 冻结保证金 → 冻结首期预估 → ACTIVE。 */
  async start(input: StartReservationInput): Promise<IBillingReservation> {
    const existing = await this.findActiveByResource(input.resourceId);
    if (existing) return existing;

    const reservation = await BillingReservation.create({
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
      lastCycleSeq: 0,
      startedAt: input.startedAt,
      expectedEndAt: null,
      version: 0,
    });

    const reservationId = documentId(reservation);
    if (input.depositCents > 0) {
      await this.payments.freeze({
        accountId: input.accountId,
        amountCents: input.depositCents,
        bizId: `reservation:${reservationId}:deposit`,
        idempotentKey: `freeze:deposit:${reservationId}`,
        preCheck: input.preCheck,
        ref: { type: 'container_reservation', id: reservationId },
      });
      await BillingReservation.updateOne(
        { _id: reservationId },
        { $inc: { reservedTotal: input.depositCents } },
      );
    }
    if (input.cycleEstimateCents > 0) {
      await this.payments.freeze({
        accountId: input.accountId,
        amountCents: input.cycleEstimateCents,
        bizId: `reservation:${reservationId}:cycle:0`,
        idempotentKey: `freeze:cycle:${reservationId}:0`,
        preCheck: input.preCheck,
        ref: { type: 'container_reservation', id: reservationId },
      });
      await BillingReservation.updateOne(
        { _id: reservationId },
        { $inc: { reservedTotal: input.cycleEstimateCents } },
      );
    }
    const activated = await BillingReservation.findOneAndUpdate(
      { _id: reservationId, status: 'PENDING' },
      { $set: { status: 'ACTIVE' }, $inc: { version: 1 } },
      { new: true },
    );
    return activated ?? (await BillingReservation.findById(reservationId))!;
  }

  /**
   * 周期结算：本期分钟 → 定价 → 解冻本期预估 → 扣费（余额不足允许为负）。
   * `(reservationId, cycleSeq)` 唯一；重复消息直接返回 skipped。
   */
  async settleCycle(reservationId: string, cycleSeq: number): Promise<CycleSettlement> {
    const reservation = await this.findById(reservationId);
    if (!reservation) throw new Error('预留不存在');
    const cycleMs = 60_000;
    const windowFrom = new Date(reservation.startedAt.getTime() + cycleSeq * cycleMs);
    const windowTo = new Date(windowFrom.getTime() + cycleMs);
    const settleTo =
      reservation.expectedEndAt && reservation.expectedEndAt < windowTo
        ? reservation.expectedEndAt
        : windowTo;

    // 消息早到：等待窗口结束（下一轮消息/扫描兜底会再次触发）。
    if (settleTo.getTime() > this.now()) {
      return { settled: false, cycleSeq, minutes: 0, amount: 0, windowFrom, windowTo, cashBalance: 0 };
    }
    if (reservation.status !== 'ACTIVE') {
      return { settled: false, cycleSeq, minutes: 0, amount: 0, windowFrom, windowTo, cashBalance: 0 };
    }

    const minutes = Math.max(1, ceilMinutes(settleTo.getTime() - windowFrom.getTime()));
    const priced = await this.prices.priceContainer(minutes, windowFrom);
    const estimated = reservation.cycleEstimateCents;

    // 幂等闸门：先落周期记录，唯一索引冲突即视为已结算
    try {
      await BillingReservationCycle.create({
        reservationId: new mongoose.Types.ObjectId(reservationId),
        cycleSeq,
        windowFrom,
        windowTo: settleTo,
        minutes,
        amount: priced.amountCents,
        status: 'settled',
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        return {
          settled: false,
          cycleSeq,
          minutes: 0,
          amount: 0,
          windowFrom,
          windowTo: settleTo,
          cashBalance: 0,
        };
      }
      throw err;
    }

    if (estimated > 0) {
      await this.payments.unfreeze({
        accountId: String(reservation.accountId),
        amountCents: estimated,
        bizId: `reservation:${reservationId}:cycle:${cycleSeq}`,
        idempotentKey: `unfreeze:cycle:${reservationId}:${cycleSeq}`,
      });
      await BillingReservation.updateOne(
        { _id: reservationId },
        { $inc: { releasedTotal: estimated } },
      );
    }

    const preCheck = await this.checks.check({
      accountId: String(reservation.accountId),
      estimatedCredits: priced.amountCents,
      policy: 'accrue-and-track',
      ref: { type: 'container_reservation', id: reservationId },
    });
    const payment = await this.payments.charge({
      accountId: String(reservation.accountId),
      amountCents: priced.amountCents,
      idempotentKey: `charge:cycle:${reservationId}:${cycleSeq}`,
      bizId: `reservation:${reservationId}:cycle:${cycleSeq}`,
      preCheck: preCheck.preCheck!,
      ref: { type: 'container_reservation', id: reservationId },
      pool: 'cash',
    });

    await BillingReservation.updateOne(
      { _id: reservationId },
      {
        $inc: { settledTotal: priced.amountCents, version: 1 },
        $set: { lastSettleAt: settleTo, lastCycleSeq: cycleSeq, status: 'ACTIVE' },
      },
    );

    // 欠费宽限计时：余额不足则开始/持续计时，恢复则清零。
    const settledAccount = await this.accounts.getById(String(reservation.accountId));
    if (!settledAccount || settledAccount.availableBalance < 0) {
      await this.accounts.markInsufficient(String(reservation.accountId), new Date(this.now()));
    } else {
      await this.accounts.clearInsufficient(String(reservation.accountId));
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

  /**
   * 下一期换冻：`accrue-and-track` 预检后重冻下一期预估。
   * 返回 `frozen=false` 表示余额不足（不阻断计费，进入宽限）。
   */
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

    const check = await this.checks.check({
      accountId: String(reservation.accountId),
      estimatedCredits: estimate,
      policy: 'accrue-and-track',
      ref: { type: 'container_reservation', id: reservationId },
    });
    if (check.insufficient) {
      await this.accounts.markInsufficient(String(reservation.accountId), new Date(this.now()));
      return { frozen: false, insufficient: true };
    }

    await this.payments.freeze({
      accountId: String(reservation.accountId),
      amountCents: estimate,
      bizId: `reservation:${reservationId}:cycle:${nextSeq}`,
      idempotentKey: `freeze:cycle:${reservationId}:${nextSeq}`,
      preCheck: check.preCheck!,
      ref: { type: 'container_reservation', id: reservationId },
    });
    await BillingReservation.updateOne(
      { _id: reservationId },
      { $inc: { reservedTotal: estimate } },
    );
    await this.accounts.clearInsufficient(String(reservation.accountId));
    return { frozen: true, insufficient: false };
  }

  /** 最终结算：结清尾部分钟 + 释放全部剩余冻结（不阻塞资源释放）。 */
  async finalSettle(reservationId: string, endedAt: Date): Promise<{ minutes: number; amount: number; cashBalance: number; windowFrom: Date }> {
    const reservation = await this.findById(reservationId);
    if (!reservation || reservation.status === 'SETTLED') {
      return { minutes: 0, amount: 0, cashBalance: 0, windowFrom: endedAt };
    }
    const from = reservation.lastSettleAt ?? reservation.startedAt;
    const minutes = ceilMinutes(endedAt.getTime() - from.getTime());
    let amount = 0;
    let cashBalance = 0;

    if (minutes > 0) {
      const priced = await this.prices.priceContainer(minutes, from);
      amount = priced.amountCents;
      const preCheck = await this.checks.check({
        accountId: String(reservation.accountId),
        estimatedCredits: amount,
        policy: 'accrue-and-track',
        ref: { type: 'container_reservation', id: reservationId },
      });
      const payment = await this.payments.charge({
        accountId: String(reservation.accountId),
        amountCents: amount,
        idempotentKey: `charge:final:${reservationId}`,
        bizId: `reservation:${reservationId}:final`,
        preCheck: preCheck.preCheck!,
        ref: { type: 'container_reservation', id: reservationId },
        pool: 'cash',
      });
      cashBalance = payment.cashBalance;
    }

    const held = Math.max(0, (reservation.reservedTotal ?? 0) - (reservation.releasedTotal ?? 0));
    if (held > 0) {
      await this.payments.unfreeze({
        accountId: String(reservation.accountId),
        amountCents: held,
        bizId: `reservation:${reservationId}:final-release`,
        idempotentKey: `unfreeze:final:${reservationId}`,
      });
    }

    await BillingReservation.updateOne(
      { _id: reservationId, status: { $ne: 'SETTLED' } },
      {
        $inc: {
          settledTotal: amount,
          releasedTotal: held,
          version: 1,
        },
        $set: { status: 'SETTLED', lastSettleAt: endedAt },
      },
    );
    const account = await this.accounts.getById(String(reservation.accountId));
    if (!account || account.availableBalance < 0) {
      await this.accounts.markInsufficient(String(reservation.accountId), new Date(this.now()));
    } else {
      await this.accounts.clearInsufficient(String(reservation.accountId));
    }
    return { minutes, amount, cashBalance, windowFrom: from };
  }
}

export const reservationService = new ReservationService();
