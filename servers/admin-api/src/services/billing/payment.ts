import mongoose from 'mongoose';
import { BillingLedger, type IBillingLedger } from '../../models/billing-ledger.js';
import { BillingPayment } from '../../models/billing-payment.js';
import { BillingAccount, type IBillingAccount } from '../../models/billing-account.js';
import { creditCheckService, type CreditCheckRef, type PreCheck } from './credit-check.js';
import { availableCents } from './money.js';
import { documentId } from './id.js';

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

/** 资金变动底层：ledger 幂等闸门 + wallet 原子更新（冻结额永不为负）。 */
export class PaymentService {
  constructor(
    private readonly prechecks = creditCheckService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async loadAccount(accountId: string): Promise<IBillingAccount | null> {
    if (!mongoose.isValidObjectId(accountId)) return null;
    return BillingAccount.findById(accountId).lean<IBillingAccount | null>();
  }

  private async applyWallet(input: {
    accountId: string;
    cashDelta: number;
    giftDelta: number;
    frozenDelta: number;
  }): Promise<{ cashBalance: number; giftBalance: number; frozenAmount: number }> {
    const doc = await BillingAccount.findByIdAndUpdate(
      input.accountId,
      [
        {
          $set: {
            cashBalance: {
              $add: [{ $ifNull: ['$cashBalance', 0] }, input.cashDelta],
            },
            giftBalance: {
              $add: [{ $ifNull: ['$giftBalance', 0] }, input.giftDelta],
            },
            frozenAmount: {
              $max: [0, { $add: [{ $ifNull: ['$frozenAmount', 0] }, input.frozenDelta] }],
            },
          },
        },
      ],
      { new: true, updatePipeline: true } as never,
    ).lean<IBillingAccount | null>();
    if (!doc) throw new Error('账户不存在');
    return {
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

    let ledger: IBillingLedger | null = null;
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
    }

    if (!ledger) {
      const account = await this.loadAccount(input.accountId);
      return {
        applied: false,
        cashBalance: account?.cashBalance ?? 0,
        frozenAmount: account?.frozenAmount ?? 0,
        ledgerId: null,
        allocations: [],
      };
    }

    const wallet = await this.applyWallet({
      accountId: input.accountId,
      cashDelta: 0,
      giftDelta: 0,
      frozenDelta: input.amountCents,
    });
    return { applied: true, ...wallet, ledgerId: documentId(ledger), allocations: [] };
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

    let ledger: IBillingLedger | null = null;
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
    }
    if (!ledger) {
      const account = await this.loadAccount(input.accountId);
      return {
        applied: false,
        cashBalance: account?.cashBalance ?? 0,
        frozenAmount: account?.frozenAmount ?? 0,
        ledgerId: null,
        allocations: [],
      };
    }

    const wallet = await this.applyWallet({
      accountId: input.accountId,
      cashDelta: 0,
      giftDelta: 0,
      frozenDelta: -input.amountCents,
    });
    return { applied: true, ...wallet, ledgerId: documentId(ledger), allocations: [] };
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
    const account = await this.loadAccount(input.accountId);
    if (!account) throw new Error('账户不存在');
    const allocations = allocatePools(account, amount);
    const cashUse = allocations
      .filter((item) => item.pool === 'cash')
      .reduce((sum, item) => sum + item.amount, 0);
    const creditUse = allocations
      .filter((item) => item.pool === 'credit')
      .reduce((sum, item) => sum + item.amount, 0);
    const giftUse = allocations
      .filter((item) => item.pool === 'gift')
      .reduce((sum, item) => sum + item.amount, 0);

    let ledger: IBillingLedger | null = null;
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
    }
    if (!ledger) {
      const current = await this.loadAccount(input.accountId);
      return {
        applied: false,
        cashBalance: current?.cashBalance ?? 0,
        frozenAmount: current?.frozenAmount ?? 0,
        ledgerId: null,
        allocations: [],
      };
    }

    const wallet = await this.applyWallet({
      accountId: input.accountId,
      cashDelta: -(cashUse + creditUse),
      giftDelta: -giftUse,
      frozenDelta: -release,
    });

    if (amount > 0) {
      await BillingPayment.create({
        invoiceId: input.invoiceId ?? null,
        accountId: input.accountId,
        amount,
        pools: input.pool
          ? [{ pool: input.pool, amount }]
          : allocations,
        releasedFrozen: release,
        status: 'succeeded',
        idempotentKey: input.idempotentKey,
        createdAt: new Date(this.now()),
      }).catch((err: { code?: number }) => {
        if (err.code !== 11000) throw err;
      });
    }

    return {
      applied: true,
      cashBalance: wallet.cashBalance,
      frozenAmount: wallet.frozenAmount,
      ledgerId: documentId(ledger),
      allocations,
    };
  }

  /** 充值入现金池：写 recharge 流水并增加余额。 */
  async recharge(input: {
    accountId: string;
    amountCents: number;
    idempotentKey: string;
    bizId: string;
  }): Promise<WalletMutationResult> {
    if (input.amountCents <= 0) throw new Error('充值金额必须为正数');
    let ledger: IBillingLedger | null = null;
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
    }
    if (!ledger) {
      const account = await this.loadAccount(input.accountId);
      return {
        applied: false,
        cashBalance: account?.cashBalance ?? 0,
        frozenAmount: account?.frozenAmount ?? 0,
        ledgerId: null,
        allocations: [],
      };
    }

    const wallet = await this.applyWallet({
      accountId: input.accountId,
      cashDelta: input.amountCents,
      giftDelta: 0,
      frozenDelta: 0,
    });
    const updated = await this.loadAccount(input.accountId);
    if (updated && availableCents(updated) >= 0) {
      await BillingAccount.updateOne(
        { _id: input.accountId },
        { $set: { insufficientSince: null } },
      );
    }
    return {
      applied: true,
      cashBalance: wallet.cashBalance,
      frozenAmount: wallet.frozenAmount,
      ledgerId: documentId(ledger),
      allocations: [{ pool: 'cash', amount: input.amountCents }],
    };
  }
}

export const paymentService = new PaymentService();
