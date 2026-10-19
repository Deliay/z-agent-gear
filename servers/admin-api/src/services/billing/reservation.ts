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

/** A-5：`bizId` 前缀匹配的正则转义——`reservationId` 来自消息体，未转义时 `.*` 可跨预留求和。 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
      if (!existing) throw err;
      // 可重入（A1）：若上次 start 中途失败停在 PENDING，复用同一预留继续驱动冻结+激活；
      // 已 ACTIVE 的重复就绪直接返回（幂等）。
      if (existing.status !== 'PENDING') return existing;
      reservation = existing;
    }

    const reservationId = documentId(reservation);
    const ref = { type: 'container_reservation' as const, id: input.resourceId };
    try {
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
    } catch (err) {
      // 失败回滚（A1/A-1）：冻结中途失败不得卡死 PENDING（否则整生命周期无周期计费）。
      // **仅解冻确实落账的冻结额**：freeze 若在写 ledger 前就抛错（瞬时 DB 故障），对应键不存在，
      // 无条件解冻会释放同账户其他预留的冻结额并污染 append-only ledger（对账会把污染当真值）。
      // 与 `settleCycle` 的 freezeExists 守卫保持同一口径。
      await this.rollbackFreeze({
        accountId: input.accountId,
        reservationId,
        idempotentKey: `freeze:deposit:${reservationId}`,
        amountCents: input.depositCents,
        bizId: `${reservationBizPrefix(reservationId)}deposit-rollback`,
        rollbackKey: `unfreeze:deposit-rollback:${reservationId}`,
      });
      await this.rollbackFreeze({
        accountId: input.accountId,
        reservationId,
        idempotentKey: `freeze:cycle:${reservationId}:0`,
        amountCents: input.cycleEstimateCents,
        bizId: `${reservationBizPrefix(reservationId)}cycle:0-rollback`,
        rollbackKey: `unfreeze:cycle-rollback:${reservationId}:0`,
      });
      await BillingReservation.updateOne(
        { _id: reservationId, status: 'PENDING' },
        { $set: { status: 'FAILED' }, $inc: { version: 1 } },
      );
      throw err;
    }
    await this.recomputeTotals(reservationId, input.accountId);
    const activated = await BillingReservation.findOneAndUpdate(
      { _id: reservationId, status: 'PENDING' },
      { $set: { status: 'ACTIVE' }, $inc: { version: 1 } },
      { new: true },
    );
    return activated ?? (await BillingReservation.findById(reservationId))!;
  }

  /** A-1：回滚冻结——仅当对应 freeze 流水确实落账时，按**实际冻结额**解冻。 */
  private async rollbackFreeze(input: {
    accountId: string;
    reservationId: string;
    idempotentKey: string;
    amountCents: number;
    bizId: string;
    rollbackKey: string;
  }): Promise<void> {
    if (input.amountCents <= 0) return;
    try {
      const freeze = await BillingLedger.findOne({
        accountId: new mongoose.Types.ObjectId(input.accountId),
        idempotentKey: input.idempotentKey,
      })
        .select({ deltaFrozen: 1 })
        .lean<{ deltaFrozen?: number } | null>();
      if (!freeze) return; // 未落账：不得解冻（否则蚕食同账户其他预留的冻结额）
      const frozen = Math.min(
        Math.max(0, Math.round(freeze.deltaFrozen ?? 0)),
        Math.round(input.amountCents),
      );
      if (frozen <= 0) return;
      await this.payments.unfreeze({
        accountId: input.accountId,
        amountCents: frozen,
        bizId: input.bizId,
        idempotentKey: input.rollbackKey,
      });
    } catch {
      // 回滚失败不掩盖原始错误：预留仍置 FAILED，由资源对账/人工收口。
    }
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

    // 去重门（阻断项 3）：该 cycle 已结算过则直接返回「未结算」，不再执行副作用。
    // at-least-once 下重复投递是常态；消费端据此不再投递下一期，断开指数放大链。
    const alreadySettled = await BillingReservationCycle.exists({
      reservationId: new mongoose.Types.ObjectId(reservationId),
      cycleSeq,
      status: 'settled',
    });
    if (alreadySettled) {
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

    // 仅当该周期确实冻结过才解冻，避免欠费周期无冻结却释放、蚕食保证金。
    // 🟡11：解冻额以 **freeze 流水实际 `deltaFrozen`** 为准（而非 `cycleEstimateCents`），
    // 与 `rollbackFreeze` 同口径，避免估算与实冻偏差时超解冻。
    const freezeKey = `freeze:cycle:${reservationId}:${cycleSeq}`;
    const freezeRow = await BillingLedger.findOne({ idempotentKey: freezeKey, accountId })
      .select({ deltaFrozen: 1 })
      .lean<{ deltaFrozen?: number } | null>();
    if (freezeRow) {
      const frozen = Math.max(0, Math.round(freezeRow.deltaFrozen ?? 0));
      if (frozen > 0) {
        await this.payments.unfreeze({
          accountId,
          amountCents: frozen,
          bizId: `${reservationBizPrefix(reservationId)}cycle:${cycleSeq}`,
          idempotentKey: `unfreeze:cycle:${reservationId}:${cycleSeq}`,
        });
      }
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
      { _id: reservationId, status: 'ACTIVE' },
      [
        {
          $set: {
            lastSettleAt: {
              $cond: [{ $gt: ['$lastSettleAt', settleTo] }, '$lastSettleAt', settleTo],
            },
            lastCycleSeq: {
              $max: [{ $ifNull: ['$lastCycleSeq', -1] }, cycleSeq],
            },
            // A2：expectedEndAt 用 $max 守卫，旧 cycle 重放不得回拨到期时间（否则被误判 stale 提前 finalize）。
            expectedEndAt: {
              $max: [
                { $ifNull: ['$expectedEndAt', new Date(0)] },
                new Date(settleTo.getTime() + 2 * this.cycleMs),
              ],
            },
            // A2：仅当仍为 ACTIVE 时保持 ACTIVE，绝不复活已 SETTLED/SETTLING 的预留。
            status: { $cond: [{ $eq: ['$status', 'ACTIVE'] }, 'ACTIVE', '$status'] },
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

  /**
   * 最终结算：结清尾部分钟 + 释放全部剩余冻结（不阻塞资源释放）。
   *
   * A-3：若预留已 `SETTLED`（例如控制面误判 stale 提前终结），后续真实的 destroyed 事件
   * 携带更晚的 `endedAt` 时，必须识别并补结「SETTLED 之后到真正销毁之间」的缺额，
   * 而不是静默返回 0 让容器免费跑。缺额使用独立幂等键
   * `charge:final-gap:${reservationId}:${lastSettleAt.getTime()}`（同窗口重复事件幂等）。
   */
  async finalSettle(
    reservationId: string,
    endedAt: Date,
  ): Promise<{
    minutes: number;
    amount: number;
    cashBalance: number;
    windowFrom: Date;
    /** 本次是否为「SETTLED 之后的缺额补结」。 */
    tail?: boolean;
  }> {
    const reservation = await this.findById(reservationId);
    if (!reservation) {
      return { minutes: 0, amount: 0, cashBalance: 0, windowFrom: endedAt };
    }
    const accountId = String(reservation.accountId);
    if (reservation.status === 'SETTLED') {
      return this.settleTailAfterSettled(reservation, accountId, endedAt);
    }
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
      if (!latest) {
        return { minutes: 0, amount: 0, cashBalance: 0, windowFrom: from };
      }
      if (latest.status === 'SETTLED') {
        // A-3：并发下已被另一路径终结（可能基于更早的 expectedEndAt）；识别并补结缺额。
        return this.settleTailAfterSettled(latest, accountId, endedAt);
      }
      if (latest.status !== 'SETTLING' && latest.status !== 'RELEASE_PENDING') {
        // 🟡2：非「本次 CAS 的后续状态」时不得穿行扣费（避免在他人所有权下重复出账/金额错位）。
        return { minutes: 0, amount: 0, cashBalance: 0, windowFrom: from };
      }
      // SETTLING/RELEASE_PENDING：上一次最终结算中途崩溃的恢复路径，继续收敛（幂等键保证不重复扣）。
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
      if (!payment.applied) {
        // 🟡2：上一轮已扣过（同一幂等键）时以 **ledger 实际入账额** 为准回填，避免
        // 「重算窗口更晚 → 账单金额 ≠ ledger 金额」的账实不符。
        const existing = await BillingLedger.findOne({
          accountId: new mongoose.Types.ObjectId(accountId),
          idempotentKey: `charge:final:${reservationId}`,
        })
          .select({ deltaBalance: 1 })
          .lean<{ deltaBalance?: number } | null>();
        if (existing) amount = Math.abs(Math.round(existing.deltaBalance ?? 0));
      }
    }

    // 当前仍被该预留占用的冻结额（以 ledger 为准，重复执行时自然为 0）
    const held = await this.heldFrozen(reservationId, accountId);
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

  /**
   * A-3：补结「预留已 SETTLED，但真实销毁事件更晚」的缺额窗口。
   * 幂等键带窗口起点，同一 destroyed 事件重放不会重复扣费；不同 endedAt 各补各的缺口。
   * 只补结、不改变预留终态（已释放的冻结不会被重新冻结）。
   */
  private async settleTailAfterSettled(
    reservation: IBillingReservation,
    accountId: string,
    endedAt: Date,
  ): Promise<{
    minutes: number;
    amount: number;
    cashBalance: number;
    windowFrom: Date;
    tail?: boolean;
  }> {
    let from = reservation.lastSettleAt ?? reservation.startedAt;
    if (endedAt.getTime() <= from.getTime()) {
      return { minutes: 0, amount: 0, cashBalance: 0, windowFrom: from };
    }
    // 先 CAS 推进 lastSettleAt，保证同一窗口只有一个请求补结；失败则重读重试一次
    // （🟡2：CAS 失败不得静默丢尾差）。
    let claimed: unknown = null;
    let latest = reservation;
    for (let attempt = 0; attempt < 2 && !claimed; attempt += 1) {
      claimed = await BillingReservation.findOneAndUpdate(
        {
          _id: documentId(latest),
          status: 'SETTLED',
          lastSettleAt: latest.lastSettleAt,
        },
        { $set: { lastSettleAt: endedAt }, $inc: { version: 1 } },
        { new: true },
      );
      if (claimed) break;
      const reread = await this.findById(documentId(reservation));
      if (!reread || reread.status !== 'SETTLED') break;
      from = reread.lastSettleAt ?? reread.startedAt;
      if (endedAt.getTime() <= from.getTime()) {
        return { minutes: 0, amount: 0, cashBalance: 0, windowFrom: from };
      }
      latest = reread;
    }
    if (!claimed) {
      return { minutes: 0, amount: 0, cashBalance: 0, windowFrom: from };
    }
    const minutes = ceilMinutes(endedAt.getTime() - from.getTime());
    if (minutes <= 0) {
      return { minutes: 0, amount: 0, cashBalance: 0, windowFrom: from, tail: true };
    }
    const priced = await this.prices.priceContainer(minutes, from);
    const preCheck = await this.checks.check({
      accountId,
      estimatedCredits: priced.amountCents,
      policy: 'accrue-and-track',
      ref: { type: 'container_reservation', id: documentId(reservation) },
    });
    const payment = await this.payments.charge({
      accountId,
      amountCents: priced.amountCents,
      idempotentKey: `charge:final-gap:${documentId(reservation)}:${from.getTime()}`,
      bizId: `${reservationBizPrefix(documentId(reservation))}final-gap`,
      preCheck: preCheck.preCheck!,
      ref: { type: 'container_reservation', id: documentId(reservation) },
    });
    await this.recomputeTotals(documentId(reservation), accountId);
    const account = await this.accounts.getById(accountId);
    if (!account || account.availableBalance < 0) {
      await this.accounts.markInsufficient(accountId, new Date(this.now()));
    }
    return {
      minutes,
      amount: priced.amountCents,
      cashBalance: payment.cashBalance,
      windowFrom: from,
      tail: true,
    };
  }

  /**
   * 预留当前占用的冻结额（ledger 合计）。
   * A-5：必须过滤 `accountId`（避免全表扫 + 跨账户误算），并对 `bizId` 正则转义。
   */
  async heldFrozen(reservationId: string, accountId?: string): Promise<number> {
    const match: Record<string, unknown> = {
      bizId: { $regex: `^${escapeRegExp(reservationBizPrefix(reservationId))}` },
    };
    if (accountId) match.accountId = new mongoose.Types.ObjectId(accountId);
    const rows = (await BillingLedger.aggregate([
      { $match: match },
      { $group: { _id: null, frozen: { $sum: '$deltaFrozen' } } },
    ])) as Array<{ frozen: number }>;
    return Math.max(0, Math.round(rows[0]?.frozen ?? 0));
  }

  /** 预留累计口径以 ledger 为准重算（幂等，供展示与对账）。 */
  async recomputeTotals(reservationId: string, accountId: string): Promise<void> {
    const rows = (await BillingLedger.aggregate([
      {
        $match: {
          accountId: new mongoose.Types.ObjectId(accountId),
          bizId: { $regex: `^${escapeRegExp(reservationBizPrefix(reservationId))}` },
        },
      },
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
