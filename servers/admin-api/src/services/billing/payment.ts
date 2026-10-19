import mongoose from 'mongoose';
import { BillingLedger, type IBillingLedger } from '../../models/billing-ledger.js';
import { BillingPayment } from '../../models/billing-payment.js';
import { BillingAccount, type IBillingAccount } from '../../models/billing-account.js';
import { creditCheckService, type CreditCheckRef, type PreCheck } from './credit-check.js';
import { availableCents } from './money.js';
import { documentId } from './id.js';
import { KeyedMutex } from './keyed-mutex.js';

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
  private readonly accountMutex = new KeyedMutex();

  constructor(
    private readonly prechecks = creditCheckService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async loadAccount(accountId: string): Promise<IBillingAccount | null> {
    if (!mongoose.isValidObjectId(accountId)) return null;
    return BillingAccount.findById(accountId).lean<IBillingAccount | null>();
  }

  private async loadLedger(idempotentKey: string): Promise<LedgerDoc | null> {
    return BillingLedger.findOne({ idempotentKey }).lean<LedgerDoc | null>();
  }

  /**
   * 把一条已落账的 ledger 行的资金影响同步到钱包快照——**原子且恰好一次**（R1）：
   * 以账户文档上的 `appliedLedgerIds` 水位做过滤 `{$ne: ledgerId}`，在**同一条** update 里
   * 完成「`$inc` 余额 + 追加水位」。因过滤命中才写入：
   * - 崩溃在 ledger 落账后、钱包更新前 → 重放时过滤命中原（`appliedLedgerIds` 不含该行）→ 补做；
   * - 崩溃在钱包更新后、标记前 → 水位已随余额一并写入 → 重放过滤不命中 → 不重复扣。
   * 无需事务即可保证「已记账必扣钱」且不重复，最长漂移窗口归零（对账仅作兜底）。
   */
  private async applyLedgerDelta(
    ledger: LedgerDoc,
    accountId: string,
  ): Promise<{ applied: boolean; cashBalance: number; giftBalance: number; frozenAmount: number }> {
    const ledgerId = String(ledger._id);
    const bizType = ledger.bizType;
    let cashDelta = 0;
    let giftDelta = 0;
    for (const allocation of ledger.allocations ?? []) {
      const signed =
        bizType === 'charge' ? -allocation.amount : bizType === 'recharge' ? allocation.amount : 0;
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
      ledger = await this.loadLedger(input.idempotentKey);
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
      ledger = await this.loadLedger(input.idempotentKey);
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
          deltaBalance: -amount,
          deltaFrozen: -release,
          allocations,
          bizId: input.bizId,
          idempotentKey: input.idempotentKey,
          createdAt: new Date(this.now()),
        });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        ledger = await this.loadLedger(input.idempotentKey);
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
      ledger = await this.loadLedger(input.idempotentKey);
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
  }
}

export const paymentService = new PaymentService();
