import { BillingLedger, type IBillingLedger } from '../../models/billing-ledger.js';
import { BillingPayment } from '../../models/billing-payment.js';
import { BillingAccount, type IBillingAccount } from '../../models/billing-account.js';
import { creditCheckService, type CreditCheckRef, type PreCheck } from './credit-check.js';
import { availableCents } from './money.js';
import { documentId } from './id.js';

export type PaymentPool = 'cash' | 'gift' | 'credit';

export interface WalletMutationResult {
  applied: boolean;
  cashBalance: number;
  frozenAmount: number;
  ledgerId: string | null;
}

/** 资金变动底层：ledger 幂等闸门 + wallet 原子更新（冻结额永不为负）。 */
export class PaymentService {
  constructor(
    private readonly prechecks = creditCheckService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async applyWallet(
    accountId: string,
    deltaBalance: number,
    deltaFrozen: number,
  ): Promise<{ cashBalance: number; frozenAmount: number }> {
    const doc = await BillingAccount.findByIdAndUpdate(
      accountId,
      [
        {
          $set: {
            cashBalance: { $add: [{ $ifNull: ['$cashBalance', 0] }, deltaBalance] },
            frozenAmount: {
              $max: [0, { $add: [{ $ifNull: ['$frozenAmount', 0] }, deltaFrozen] }],
            },
          },
        },
      ],
      { new: true },
    ).lean<IBillingAccount | null>();
    if (!doc) throw new Error('账户不存在');
    return { cashBalance: doc.cashBalance ?? 0, frozenAmount: doc.frozenAmount ?? 0 };
  }

  /**
   * 冻结（保证金/周期预估）：写 freeze 流水并增加冻结额。
   * 必须携带预检凭证（唯一同步卡点）。
   */
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
      const account = await BillingAccount.findById(input.accountId).lean<IBillingAccount | null>();
      return {
        applied: false,
        cashBalance: account?.cashBalance ?? 0,
        frozenAmount: account?.frozenAmount ?? 0,
        ledgerId: null,
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
        bizId: input.bizId,
        idempotentKey: input.idempotentKey,
        createdAt: new Date(this.now()),
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }

    if (!ledger) {
      const account = await BillingAccount.findById(input.accountId).lean<IBillingAccount | null>();
      return {
        applied: false,
        cashBalance: account?.cashBalance ?? 0,
        frozenAmount: account?.frozenAmount ?? 0,
        ledgerId: null,
      };
    }

    const wallet = await this.applyWallet(input.accountId, 0, input.amountCents);
    return { applied: true, ...wallet, ledgerId: documentId(ledger) };
  }

  /** 解冻（周期换冻/最终释放）：写 unfreeze 流水并减少冻结额（下限 0）。 */
  async unfreeze(input: {
    accountId: string;
    amountCents: number;
    bizId: string;
    idempotentKey: string;
  }): Promise<WalletMutationResult> {
    if (input.amountCents <= 0) {
      const account = await BillingAccount.findById(input.accountId).lean<IBillingAccount | null>();
      return {
        applied: false,
        cashBalance: account?.cashBalance ?? 0,
        frozenAmount: account?.frozenAmount ?? 0,
        ledgerId: null,
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
        bizId: input.bizId,
        idempotentKey: input.idempotentKey,
        createdAt: new Date(this.now()),
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
    if (!ledger) {
      const account = await BillingAccount.findById(input.accountId).lean<IBillingAccount | null>();
      return {
        applied: false,
        cashBalance: account?.cashBalance ?? 0,
        frozenAmount: account?.frozenAmount ?? 0,
        ledgerId: null,
      };
    }

    const wallet = await this.applyWallet(input.accountId, 0, -input.amountCents);
    return { applied: true, ...wallet, ledgerId: documentId(ledger) };
  }

  /**
   * 扣费（结算/消费）：优先消耗冻结额（releaseFrozenCents），余额不足允许为负（欠费）。
   * 必须携带预检凭证；`idempotentKey` 唯一保证重放安全。
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

    let ledger: IBillingLedger | null = null;
    try {
      ledger = await BillingLedger.create({
        accountId: input.accountId,
        pool: input.pool ?? 'cash',
        bizType: 'charge',
        deltaBalance: -amount,
        deltaFrozen: -release,
        bizId: input.bizId,
        idempotentKey: input.idempotentKey,
        createdAt: new Date(this.now()),
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
    if (!ledger) {
      const account = await BillingAccount.findById(input.accountId).lean<IBillingAccount | null>();
      return {
        applied: false,
        cashBalance: account?.cashBalance ?? 0,
        frozenAmount: account?.frozenAmount ?? 0,
        ledgerId: null,
      };
    }

    const wallet = await this.applyWallet(input.accountId, -amount, -release);

    if (amount > 0) {
      await BillingPayment.create({
        invoiceId: input.invoiceId ?? null,
        accountId: input.accountId,
        amount,
        pools: [
          ...(release > 0 ? [{ pool: 'frozen' as const, amount: release }] : []),
          { pool: input.pool ?? 'cash', amount },
        ],
        status: 'succeeded',
        idempotentKey: input.idempotentKey,
        createdAt: new Date(this.now()),
      }).catch((err: { code?: number }) => {
        if (err.code !== 11000) throw err;
      });
    }

    return { applied: true, ...wallet, ledgerId: documentId(ledger) };
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
        bizId: input.bizId,
        idempotentKey: input.idempotentKey,
        createdAt: new Date(this.now()),
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
    if (!ledger) {
      const account = await BillingAccount.findById(input.accountId).lean<IBillingAccount | null>();
      return {
        applied: false,
        cashBalance: account?.cashBalance ?? 0,
        frozenAmount: account?.frozenAmount ?? 0,
        ledgerId: null,
      };
    }

    const wallet = await this.applyWallet(input.accountId, input.amountCents, 0);
    const account = await BillingAccount.findById(input.accountId).lean<IBillingAccount | null>();
    if (account && availableCents(account) >= 0) {
      await BillingAccount.updateOne(
        { _id: input.accountId },
        { $set: { insufficientSince: null } },
      );
    }
    return { applied: true, ...wallet, ledgerId: documentId(ledger) };
  }
}

export const paymentService = new PaymentService();
