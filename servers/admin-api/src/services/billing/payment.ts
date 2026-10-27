import mongoose from 'mongoose';
import { BillingAppliedLedger } from '../../models/billing-applied-ledger.js';
import { BillingLedger, type IBillingLedger } from '../../models/billing-ledger.js';
import { BillingPayment } from '../../models/billing-payment.js';
import { BillingAccount, type IBillingAccount } from '../../models/billing-account.js';
import { deriveWalletFromLedger } from './account-service.js';
import { creditCheckService, type CreditCheckRef, type PreCheck } from './credit-check.js';
import { availableCents } from './money.js';
import { documentId } from './id.js';
import { accountMutex } from './keyed-mutex.js';

/** 钱包同步租约：超过该时长仍停在 pending 视为上次同步中途崩溃，走自愈而非重复累加。 */
const LEDGER_APPLY_LEASE_MS = 60_000;

export type PaymentPool = 'cash' | 'gift' | 'credit';

export interface PoolAllocation {
  pool: PaymentPool;
  amount: number;
}

export interface WalletMutationResult {
  applied: boolean;
  cashBalance: number;
  frozenAmount: number;
  ledgerId: string | null;
  allocations: PoolAllocation[];
}

interface AccountSnapshot {
  cashBalance: number;
  giftBalance: number;
  creditLimit: number;
  frozenAmount: number;
}

type LedgerDoc = IBillingLedger & { _id: unknown };

/**
 * 拆池分配：现金 → 赠送金 → 授信（透支为负现金）。
 * `amount` 为本次实际需要从资金池扣除的金额（不含冻结额释放）。
 */
export function allocatePools(account: AccountSnapshot, amount: number): PoolAllocation[] {
  let remaining = Math.max(0, Math.round(amount));
  const allocations: PoolAllocation[] = [];
  const cashAvailable = Math.max(0, Math.round(account.cashBalance));
  const cashUse = Math.min(remaining, cashAvailable);
  if (cashUse > 0) {
    allocations.push({ pool: 'cash', amount: cashUse });
    remaining -= cashUse;
  }
  const giftAvailable = Math.max(0, Math.round(account.giftBalance));
  const giftUse = Math.min(remaining, giftAvailable);
  if (giftUse > 0) {
    allocations.push({ pool: 'gift', amount: giftUse });
    remaining -= giftUse;
  }
  if (remaining > 0) {
    allocations.push({ pool: 'credit', amount: remaining });
  }
  return allocations;
}

/** 资金变动底层：ledger 幂等闸门 + 两阶段钱包同步（冻结额永不为负）。 */
export class PaymentService {
  /** 账户级互斥：同账户并发扣费串行化拆池决策，避免赠送额被双重分配为负（A3）。 */
  private readonly accountMutex = accountMutex;

  constructor(
    private readonly prechecks = creditCheckService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async loadAccount(accountId: string): Promise<IBillingAccount | null> {
    if (!mongoose.isValidObjectId(accountId)) return null;
    return BillingAccount.findById(accountId).lean<IBillingAccount | null>();
  }

  /**
   * 按幂等键回读已落账的 ledger 行。
   * A-6：必须同时校验归属——幂等键全局唯一是事实，但**不是安全边界**，任何未来开放
   * `idempotentKey` 入参的入口都可能拿他人流水做「跨账户造钱/销账」。键存在但归属不符即抛错。
   */
  private async loadLedger(idempotentKey: string, accountId: string): Promise<LedgerDoc | null> {
    const ledger = await BillingLedger.findOne({ idempotentKey }).lean<LedgerDoc | null>();
    if (!ledger) return null;
    if (String(ledger.accountId) !== String(accountId)) {
      throw new Error(
        `ledger idempotentKey ${idempotentKey} belongs to another account (expected ${accountId}, got ${String(ledger.accountId)})`,
      );
    }
    return ledger;
  }

  /**
   * 把一条已落账的 ledger 行的资金影响同步到钱包快照——**原子且恰好一次**（R1/A-2）：
   *
   * 幂等闸门 = 独立集合 `billingappliedledgers` 的 `{accountId, ledgerId}` 唯一标记（**不淘汰**）。
   * 账户文档上的 `appliedLedgerIds` 水位只是「最近 N 条」的辅助索引，会因 `$slice` 淘汰，
   * 因此**不能**作为幂等性的唯一依据（A-2：水位淘汰后重放同一幂等键会二次记账）。
   *
   * 状态机：`pending`（已插入标记、钱包未同步）→ `applied`（钱包已同步）。
   * - 标记 `applied` → 直接 no-op（at-least-once 重投 / resetCursor / DLQ 重放安全）；
   * - 标记 `pending` 且仍在租约内 → 视为并发/在途，返回 `applied:false`（不重复记账）；
   * - 标记 `pending` 且租约已过期 → 上一次同步中途崩溃（无法判断 `$inc` 是否落账），
   *   走「按 ledger 真值绝对校准」自愈，而不是再次 `$inc`。
   */
  private async applyLedgerDelta(
    ledger: LedgerDoc,
    accountId: string,
  ): Promise<{ applied: boolean; cashBalance: number; giftBalance: number; frozenAmount: number }> {
    if (String(ledger.accountId) !== String(accountId)) {
      throw new Error(
        `refuse to apply ledger ${String(ledger._id)} of account ${String(ledger.accountId)} to account ${accountId}`,
      );
    }
    const ledgerId = String(ledger._id);
    const marker = await this.claimLedgerApplication(accountId, ledgerId, ledger.walletApplied === true);
    if (marker.state === 'applied') {
      const current = await this.loadAccount(accountId);
      if (!current) throw new Error('账户不存在');
      return {
        applied: false,
        cashBalance: current.cashBalance ?? 0,
        giftBalance: current.giftBalance ?? 0,
        frozenAmount: current.frozenAmount ?? 0,
      };
    }
    if (marker.state === 'in-flight') {
      const current = await this.loadAccount(accountId);
      if (!current) throw new Error('账户不存在');
      return {
        applied: false,
        cashBalance: current.cashBalance ?? 0,
        giftBalance: current.giftBalance ?? 0,
        frozenAmount: current.frozenAmount ?? 0,
      };
    }
    if (marker.state === 'stale') {
      // 崩溃恢复：绝对校准到 ledger 真值（幂等），避免重复 `$inc`。
      const healed = await this.healWalletFromLedger(accountId);
      await this.markLedgerApplied(accountId, ledgerId);
      return { applied: true, ...healed };
    }
    const result = await this.incWalletByLedger(ledger, accountId);
    await this.markLedgerApplied(accountId, ledgerId);
    return result;
  }

  /**
   * 申请「本 ledger 的钱包同步权」：
   * - `applied`：已同步过，调用方必须 no-op；
   * - `in-flight`：另一路径正在同步（租约内），调用方不得重复记账；
   * - `stale`：租约过期（上次同步中途崩溃），调用方走自愈路径；
   * - `claimed`：本次获得同步权，正常 `$inc`。
   */
  private async claimLedgerApplication(
    accountId: string,
    ledgerId: string,
    legacyAppliedFlag = false,
  ): Promise<{ state: 'claimed' | 'applied' | 'in-flight' | 'stale' }> {
    const now = new Date(this.now());
    const leaseCutoff = new Date(now.getTime() - LEDGER_APPLY_LEASE_MS);
    const tryClaim = () =>
      BillingAppliedLedger.findOneAndUpdate(
        { accountId, ledgerId, walletApplied: false, claimedAt: null },
        { $set: { claimedAt: now } },
        { new: true },
      ).lean<{ walletApplied?: boolean; claimedAt?: Date | null } | null>();

    if (await tryClaim()) return { state: 'claimed' };

    // 未拿到：区分「已应用」「在途」「陈旧」。
    let existing = await BillingAppliedLedger.findOne({ accountId, ledgerId }).lean<{
      walletApplied?: boolean;
      claimedAt?: Date | null;
    } | null>();
    if (!existing) {
      // 标记尚不存在：插入 pending 后重新申请（并发下只有一个能拿到）。
      // 兼容本机制上线前的历史流水：ledger 行上的 `walletApplied` 与账户水位数组
      // （`appliedLedgerIds`）是仅有的两个「可能已应用」信号，任一命中即视为已应用，
      // 宁可漏补（由对账校准）也不重复记账。
      const account = await this.loadAccount(accountId);
      const legacyApplied =
        legacyAppliedFlag === true || (account?.appliedLedgerIds ?? []).includes(ledgerId);
      try {
        await BillingAppliedLedger.create({
          accountId,
          ledgerId,
          walletApplied: legacyApplied,
          appliedAt: legacyApplied ? now : null,
        });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
      }
      if (await tryClaim()) return { state: 'claimed' };
      existing = await BillingAppliedLedger.findOne({ accountId, ledgerId }).lean<{
        walletApplied?: boolean;
        claimedAt?: Date | null;
      } | null>();
    }
    if (!existing) throw new Error(`failed to claim ledger application ${ledgerId}`);
    if (existing.walletApplied) return { state: 'applied' };
    const claimedAt = existing.claimedAt ? new Date(existing.claimedAt).getTime() : 0;
    if (claimedAt > leaseCutoff.getTime()) return { state: 'in-flight' };
    // 租约过期：接管（stale）。接管失败（他人刚抢到）按在途处理。
    const takenOver = await BillingAppliedLedger.findOneAndUpdate(
      { accountId, ledgerId, walletApplied: false, claimedAt: existing.claimedAt ?? null },
      { $set: { claimedAt: now } },
      { new: true },
    ).lean();
    return takenOver ? { state: 'stale' } : { state: 'in-flight' };
  }

  private async markLedgerApplied(accountId: string, ledgerId: string): Promise<void> {
    // R2-1：**不得吞错**。写失败必须让调用方感知——否则标记永停 `pending`，
    // 重放会被误判为 in-flight（租约内）或 stale（租约后自愈），把「已完成」错报为「未完成」。
    await BillingAppliedLedger.updateOne(
      { accountId, ledgerId },
      { $set: { walletApplied: true, appliedAt: new Date(this.now()), claimedAt: null } },
      { upsert: true },
    );
  }

  /**
   * 崩溃自愈：把钱包快照绝对校准到 ledger 真值（幂等，绝不重复累加）。
   * 仅在「标记 pending 且租约过期」这一极窄的故障恢复路径上使用。
   */
  private async healWalletFromLedger(
    accountId: string,
  ): Promise<{ cashBalance: number; giftBalance: number; frozenAmount: number }> {
    const derived = await deriveWalletFromLedger(accountId);
    const doc = await BillingAccount.findByIdAndUpdate(
      accountId,
      {
        $set: {
          cashBalance: derived.cashBalance,
          giftBalance: derived.giftBalance,
          frozenAmount: derived.frozenAmount,
        },
      },
      { new: true },
    ).lean<IBillingAccount | null>();
    if (!doc) throw new Error('账户不存在');
    return {
      cashBalance: doc.cashBalance ?? 0,
      giftBalance: doc.giftBalance ?? 0,
      frozenAmount: doc.frozenAmount ?? 0,
    };
  }

  /** 正常路径：`$inc` 钱包（`appliedLedgerIds` 水位作为文档级二次防重）。 */
  private async incWalletByLedger(
    ledger: LedgerDoc,
    accountId: string,
  ): Promise<{ applied: boolean; cashBalance: number; giftBalance: number; frozenAmount: number }> {
    const ledgerId = String(ledger._id);
    const bizType = ledger.bizType;
    let cashDelta = 0;
    let giftDelta = 0;
    for (const allocation of ledger.allocations ?? []) {
      const signed =
        bizType === 'charge'
          ? -allocation.amount
          : bizType === 'recharge' || bizType === 'adjust'
            ? allocation.amount
            : 0;
      if (allocation.pool === 'gift') giftDelta += signed;
      else if (allocation.pool === 'cash' || allocation.pool === 'credit') cashDelta += signed;
    }
    const frozenDelta = ledger.deltaFrozen ?? 0;
    const doc = await BillingAccount.findOneAndUpdate(
      { _id: accountId, appliedLedgerIds: { $ne: ledgerId } },
      [
        {
          $set: {
            cashBalance: { $add: [{ $ifNull: ['$cashBalance', 0] }, cashDelta] },
            giftBalance: { $add: [{ $ifNull: ['$giftBalance', 0] }, giftDelta] },
            frozenAmount: {
              $max: [0, { $add: [{ $ifNull: ['$frozenAmount', 0] }, frozenDelta] }],
            },
            // 保留最近 1000 条水位（新行 ObjectId 字典序更大，$slice 负向保留最新）。
            appliedLedgerIds: {
              $slice: [
                { $setUnion: [{ $ifNull: ['$appliedLedgerIds', []] }, [ledgerId]] },
                -1000,
              ],
            },
          },
        },
      ],
      { new: true, updatePipeline: true } as never,
    ).lean<IBillingAccount | null>();

    if (!doc) {
      // 过滤未命中：要么该行已应用（重复投递），要么账户不存在。
      const current = await this.loadAccount(accountId);
      if (!current) throw new Error('账户不存在');
      return {
        applied: false,
        cashBalance: current.cashBalance ?? 0,
        giftBalance: current.giftBalance ?? 0,
        frozenAmount: current.frozenAmount ?? 0,
      };
    }
    // 可观测性：标记 ledger 行已同步（非正确性来源，失败不影响资金）。
    await BillingLedger.collection
      .updateOne({ _id: ledger._id as never }, { $set: { walletApplied: true } })
      .catch(() => undefined);
    return {
      applied: true,
      cashBalance: doc.cashBalance ?? 0,
      giftBalance: doc.giftBalance ?? 0,
      frozenAmount: doc.frozenAmount ?? 0,
    };
  }

  /** 冻结（保证金/周期预估）：写 freeze 流水并增加冻结额。必须携带预检凭证。 */
  async freeze(input: {
    accountId: string;
    amountCents: number;
    bizId: string;
    idempotentKey: string;
    preCheck: PreCheck | string;
    ref?: CreditCheckRef;
  }): Promise<WalletMutationResult> {
    this.prechecks.verify(input.preCheck, { accountId: input.accountId, ref: input.ref });
    if (input.amountCents <= 0) {
      const account = await this.loadAccount(input.accountId);
      return {
        applied: false,
        cashBalance: account?.cashBalance ?? 0,
        frozenAmount: account?.frozenAmount ?? 0,
        ledgerId: null,
        allocations: [],
      };
    }

    let ledger: LedgerDoc | null = null;
    return this.accountMutex.runExclusive(`account:${input.accountId}`, async () => {
      try {
        ledger = await BillingLedger.create({
          accountId: input.accountId,
          pool: 'cash',
          bizType: 'freeze',
          deltaBalance: 0,
          deltaFrozen: input.amountCents,
          allocations: [],
          bizId: input.bizId,
          idempotentKey: input.idempotentKey,
          createdAt: new Date(this.now()),
        });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        ledger = await this.loadLedger(input.idempotentKey, input.accountId);
      }
      if (!ledger) throw new Error('freeze ledger not found after conflict');

      const wallet = await this.applyLedgerDelta(ledger, input.accountId);
      return {
        applied: wallet.applied,
        cashBalance: wallet.cashBalance,
        frozenAmount: wallet.frozenAmount,
        ledgerId: documentId(ledger),
        allocations: [],
      };
    });
  }

  /** 解冻：写 unfreeze 流水并减少冻结额（下限 0）。幂等。 */
  async unfreeze(input: {
    accountId: string;
    amountCents: number;
    bizId: string;
    idempotentKey: string;
  }): Promise<WalletMutationResult> {
    if (input.amountCents <= 0) {
      const account = await this.loadAccount(input.accountId);
      return {
        applied: false,
        cashBalance: account?.cashBalance ?? 0,
        frozenAmount: account?.frozenAmount ?? 0,
        ledgerId: null,
        allocations: [],
      };
    }

    let ledger: LedgerDoc | null = null;
    return this.accountMutex.runExclusive(`account:${input.accountId}`, async () => {
      try {
        ledger = await BillingLedger.create({
          accountId: input.accountId,
          pool: 'cash',
          bizType: 'unfreeze',
          deltaBalance: 0,
          deltaFrozen: -input.amountCents,
          allocations: [],
          bizId: input.bizId,
          idempotentKey: input.idempotentKey,
          createdAt: new Date(this.now()),
        });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        ledger = await this.loadLedger(input.idempotentKey, input.accountId);
      }
      if (!ledger) throw new Error('unfreeze ledger not found after conflict');

      const wallet = await this.applyLedgerDelta(ledger, input.accountId);
      return {
        applied: wallet.applied,
        cashBalance: wallet.cashBalance,
        frozenAmount: wallet.frozenAmount,
        ledgerId: documentId(ledger),
        allocations: [],
      };
    });
  }

  /**
   * 扣费（结算/消费）：拆池 现金 → 赠送金 → 授信（余额不足允许为负）；
   * `releaseFrozenCents` 表示同时释放的冻结额（保证金/预留）。必须携带预检凭证。
   */
  async charge(input: {
    accountId: string;
    amountCents: number;
    idempotentKey: string;
    bizId: string;
    invoiceId?: string | null;
    releaseFrozenCents?: number;
    preCheck: PreCheck | string;
    ref?: CreditCheckRef;
    pool?: PaymentPool;
  }): Promise<WalletMutationResult> {
    this.prechecks.verify(input.preCheck, { accountId: input.accountId, ref: input.ref });
    if (input.amountCents < 0) throw new Error('扣费金额不能为负数');

    const amount = Math.round(input.amountCents);
    const release = Math.max(0, Math.round(input.releaseFrozenCents ?? 0));
    // 账户级互斥（A3）：拆池决策必须基于「同一时刻」的账户快照，否则同账户并发扣费
    // 会双重分配同一份赠送额、把 giftBalance 打成负数。串行化后每次 allocatePools 都看到前一笔的结果。
    return this.accountMutex.runExclusive(`account:${input.accountId}`, async () => {
      const account = await this.loadAccount(input.accountId);
      if (!account) throw new Error('账户不存在');
      const allocations = allocatePools(account, amount);

      let ledger: LedgerDoc | null = null;
      try {
        ledger = await BillingLedger.create({
          accountId: input.accountId,
          pool: allocations.some((item) => item.pool === 'credit') ? 'credit' : 'cash',
          bizType: 'charge',
          // R5-2：零价尾段也会落 0 元流水；显式写 `0`（避免 `-0`，保持账实与断言口径干净）。
          deltaBalance: amount === 0 ? 0 : -amount,
          deltaFrozen: -release,
          allocations,
          bizId: input.bizId,
          idempotentKey: input.idempotentKey,
          createdAt: new Date(this.now()),
        });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        ledger = await this.loadLedger(input.idempotentKey, input.accountId);
      }
      if (!ledger) throw new Error('charge ledger not found after conflict');

      const wallet = await this.applyLedgerDelta(ledger, input.accountId);

      if (wallet.applied && amount > 0) {
        await BillingPayment.create({
          invoiceId: input.invoiceId ?? null,
          accountId: input.accountId,
          amount,
          pools: input.pool ? [{ pool: input.pool, amount }] : allocations,
          releasedFrozen: release,
          status: 'succeeded',
          idempotentKey: input.idempotentKey,
          createdAt: new Date(this.now()),
        }).catch((err: { code?: number }) => {
          if (err.code !== 11000) throw err;
        });
      }

      return {
        applied: wallet.applied,
        cashBalance: wallet.cashBalance,
        frozenAmount: wallet.frozenAmount,
        ledgerId: documentId(ledger),
        allocations: (ledger.allocations ?? []).map((item) => ({
          pool: item.pool as PaymentPool,
          amount: item.amount,
        })),
      };
    });
  }

  /** 充值入现金池：写 recharge 流水并增加余额。 */
  async recharge(input: {
    accountId: string;
    amountCents: number;
    idempotentKey: string;
    bizId: string;
  }): Promise<WalletMutationResult> {
    if (input.amountCents <= 0) throw new Error('充值金额必须为正数');
    let ledger: LedgerDoc | null = null;
    return this.accountMutex.runExclusive(`account:${input.accountId}`, async () => {
      try {
        ledger = await BillingLedger.create({
          accountId: input.accountId,
          pool: 'cash',
          bizType: 'recharge',
          deltaBalance: input.amountCents,
          deltaFrozen: 0,
          allocations: [{ pool: 'cash', amount: input.amountCents }],
          bizId: input.bizId,
          idempotentKey: input.idempotentKey,
          createdAt: new Date(this.now()),
        });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        ledger = await this.loadLedger(input.idempotentKey, input.accountId);
      }
      if (!ledger) throw new Error('recharge ledger not found after conflict');

      const wallet = await this.applyLedgerDelta(ledger, input.accountId);
      if (wallet.applied) {
        const updated = await this.loadAccount(input.accountId);
        if (updated && availableCents(updated) >= 0) {
          await BillingAccount.updateOne(
            { _id: input.accountId },
            { $set: { insufficientSince: null } },
          );
        }
      }
      return {
        applied: wallet.applied,
        cashBalance: wallet.cashBalance,
        frozenAmount: wallet.frozenAmount,
        ledgerId: documentId(ledger),
        allocations: [{ pool: 'cash', amount: input.amountCents }],
      };
    });
  }

  /** 退款入现金池：写 adjust 正向流水并增加余额（仅用于一次性费用的失败退款）。 */
  async refund(input: {
    accountId: string;
    amountCents: number;
    idempotentKey: string;
    bizId: string;
    invoiceId?: string | null;
  }): Promise<WalletMutationResult> {
    if (input.amountCents <= 0) throw new Error('退款金额必须为正数');
    const amount = Math.round(input.amountCents);
    let ledger: LedgerDoc | null = null;
    return this.accountMutex.runExclusive(`account:${input.accountId}`, async () => {
      try {
        ledger = await BillingLedger.create({
          accountId: input.accountId,
          pool: 'cash',
          bizType: 'adjust',
          deltaBalance: amount,
          deltaFrozen: 0,
          allocations: [{ pool: 'cash', amount }],
          bizId: input.bizId,
          idempotentKey: input.idempotentKey,
          createdAt: new Date(this.now()),
        });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        ledger = await this.loadLedger(input.idempotentKey, input.accountId);
      }
      if (!ledger) throw new Error('refund ledger not found after conflict');

      const wallet = await this.applyLedgerDelta(ledger, input.accountId);
      if (wallet.applied) {
        await BillingPayment.create({
          invoiceId: input.invoiceId ?? null,
          accountId: input.accountId,
          amount,
          pools: [{ pool: 'cash', amount }],
          releasedFrozen: 0,
          status: 'succeeded',
          idempotentKey: input.idempotentKey,
          createdAt: new Date(this.now()),
        }).catch((err: { code?: number }) => {
          if (err.code !== 11000) throw err;
        });
        const updated = await this.loadAccount(input.accountId);
        if (updated && availableCents(updated) >= 0) {
          await BillingAccount.updateOne(
            { _id: input.accountId },
            { $set: { insufficientSince: null } },
          );
        }
      }
      return {
        applied: wallet.applied,
        cashBalance: wallet.cashBalance,
        frozenAmount: wallet.frozenAmount,
        ledgerId: documentId(ledger),
        allocations: [{ pool: 'cash', amount }],
      };
    });
  }
}

export const paymentService = new PaymentService();
