import crypto from 'node:crypto';
import { BillingAccount, type IBillingAccount } from '../../models/billing-account.js';
import { availableCents } from './money.js';
import { documentId } from './id.js';

export type CreditCheckPolicy = 'reject-on-insufficient' | 'accrue-and-track';

export type CreditCheckReason = 'INSUFFICIENT_BALANCE' | 'ACCOUNT_FROZEN' | 'NOT_FOUND';

export interface CreditCheckRef {
  type: 'container_reservation' | 'model_call';
  id: string;
}

/** 预检凭证：payment/settle 必须携带，绕过即抛错（裁决 6）。 */
export interface PreCheck {
  checkId: string;
  accountId: string;
  estimated: number;
  ref: CreditCheckRef;
  createdAt: number;
  expiresAt: number;
  policy: CreditCheckPolicy;
  insufficient: boolean;
}

export interface CreditCheckResult {
  allowed: boolean;
  reason?: CreditCheckReason;
  available: number;
  insufficient: boolean;
  preCheck?: PreCheck;
}

export interface CreditCheckInput {
  accountId: string;
  /** 预估费用（分）。 */
  estimatedCredits: number;
  policy: CreditCheckPolicy;
  ref: CreditCheckRef;
}

export interface CreditCheckOptions {
  ttlMs?: number;
  now?: () => number;
  /** 可注入账户读取（测试用）；缺省读 Mongo。 */
  findAccount?: (accountId: string) => Promise<{
    id: string;
    cashBalance: number;
    giftBalance?: number | null;
    creditLimit?: number | null;
    frozenAmount?: number | null;
    status: string;
  } | null>;
}

/** 唯一额度判定入口：所有「扣费前」判断（容器保证金/周期重冻、模型调用）都经此。 */
export class CreditCheckService {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly findAccount: NonNullable<CreditCheckOptions['findAccount']>;
  private readonly checks = new Map<string, PreCheck>();

  constructor(options: CreditCheckOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
    this.findAccount =
      options.findAccount ??
      (async (accountId) => {
        const doc = await BillingAccount.findById(accountId).lean<IBillingAccount | null>();
        if (!doc) return null;
        return {
          id: documentId(doc),
          cashBalance: doc.cashBalance ?? 0,
          giftBalance: doc.giftBalance ?? 0,
          creditLimit: doc.creditLimit ?? 0,
          frozenAmount: doc.frozenAmount ?? 0,
          status: doc.status ?? 'active',
        };
      });
  }

  async check(input: CreditCheckInput): Promise<CreditCheckResult> {
    const account = await this.findAccount(input.accountId);
    const now = this.now();
    const makePreCheck = (available: number, insufficient: boolean): PreCheck => {
      const preCheck: PreCheck = {
        checkId: crypto.randomUUID(),
        accountId: input.accountId,
        estimated: input.estimatedCredits,
        ref: input.ref,
        createdAt: now,
        expiresAt: now + this.ttlMs,
        policy: input.policy,
        insufficient,
      };
      this.checks.set(preCheck.checkId, preCheck);
      this.prune(now);
      return preCheck;
    };

    if (!account) {
      // accrue-and-track 是「持续记账」策略：账户缺失/冻结也要给出凭证，
      // 由 payment 记录欠费（否则周期结算/尾结/模型出账全部进 DLQ）。
      if (input.policy === 'accrue-and-track') {
        const preCheck = makePreCheck(0, true);
        return {
          allowed: true,
          reason: 'NOT_FOUND',
          available: 0,
          insufficient: true,
          preCheck,
        };
      }
      return { allowed: false, reason: 'NOT_FOUND', available: 0, insufficient: true };
    }
    const available = availableCents(account);
    const insufficient = available - input.estimatedCredits < 0;
    if (account.status === 'frozen') {
      if (input.policy === 'accrue-and-track') {
        const preCheck = makePreCheck(available, true);
        return {
          allowed: true,
          reason: 'ACCOUNT_FROZEN',
          available,
          insufficient: true,
          preCheck,
        };
      }
      return { allowed: false, reason: 'ACCOUNT_FROZEN', available, insufficient: true };
    }
    const allowed = input.policy === 'accrue-and-track' ? true : !insufficient;
    const preCheck = makePreCheck(available, insufficient);
    return {
      allowed,
      available,
      insufficient,
      preCheck,
      ...(allowed ? {} : { reason: 'INSUFFICIENT_BALANCE' as const }),
    };
  }

  /**
   * 校验 payment/settle 的预检凭证：必须存在、未过期、accountId/ref 匹配。
   * 返回凭证本身（调用方可读取 insufficient 以做欠费宽限判断）。
   */
  verify(
    preCheck: PreCheck | string | null | undefined,
    expected: { accountId: string; ref?: CreditCheckRef },
  ): PreCheck {
    const check =
      typeof preCheck === 'string' ? this.checks.get(preCheck) : preCheck ?? undefined;
    if (!check || !this.checks.has(check.checkId)) {
      throw new Error('preCheck required: payment/settle must carry a valid credit check token');
    }
    if (check.expiresAt < this.now()) {
      this.checks.delete(check.checkId);
      throw new Error('preCheck expired');
    }
    if (check.accountId !== expected.accountId) {
      throw new Error('preCheck account mismatch');
    }
    if (expected.ref && (check.ref.type !== expected.ref.type || check.ref.id !== expected.ref.id)) {
      throw new Error('preCheck ref mismatch');
    }
    return check;
  }

  /** 仅测试/调试：当前有效凭证数。 */
  size(): number {
    return this.checks.size;
  }

  private prune(now: number): void {
    for (const [key, value] of this.checks) {
      if (value.expiresAt < now) this.checks.delete(key);
    }
  }
}

export const creditCheckService = new CreditCheckService();
