import { describe, it, expect, vi } from 'vitest';
import { CreditCheckService } from './credit-check.js';

function serviceWithAccount(account: {
  cashBalance: number;
  frozenAmount?: number;
  creditLimit?: number;
  status?: string;
}) {
  const findAccount = vi.fn(async () => ({
    id: 'acct-1',
    cashBalance: account.cashBalance,
    giftBalance: 0,
    creditLimit: account.creditLimit ?? 0,
    frozenAmount: account.frozenAmount ?? 0,
    status: account.status ?? 'active',
  }));
  return new CreditCheckService({ findAccount, now: () => 1_000_000 });
}

describe('CreditCheckService（统一预扣费检查）', () => {
  it('T-B5: reject 策略在余额不足时拒绝、充足时放行', async () => {
    const rich = serviceWithAccount({ cashBalance: 1000 });
    const allowed = await rich.check({
      accountId: 'acct-1',
      estimatedCredits: 400,
      policy: 'reject-on-insufficient',
      ref: { type: 'model_call', id: 'r1' },
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.insufficient).toBe(false);
    expect(allowed.preCheck).toBeDefined();

    const poor = serviceWithAccount({ cashBalance: 100 });
    const denied = await poor.check({
      accountId: 'acct-1',
      estimatedCredits: 400,
      policy: 'reject-on-insufficient',
      ref: { type: 'model_call', id: 'r2' },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('INSUFFICIENT_BALANCE');
    expect(denied.insufficient).toBe(true);
  });

  it('T-B5: 授信额度参与可用余额，后台账户可透支', async () => {
    const account = serviceWithAccount({ cashBalance: -100, creditLimit: 1000 });
    const result = await account.check({
      accountId: 'acct-1',
      estimatedCredits: 500,
      policy: 'reject-on-insufficient',
      ref: { type: 'model_call', id: 'r3' },
    });
    expect(result.allowed).toBe(true);
  });

  it('T-B5: 冻结额扣减可用余额；账户冻结一律拒绝', async () => {
    const account = serviceWithAccount({ cashBalance: 500, frozenAmount: 450 });
    const denied = await account.check({
      accountId: 'acct-1',
      estimatedCredits: 100,
      policy: 'reject-on-insufficient',
      ref: { type: 'model_call', id: 'r4' },
    });
    expect(denied.allowed).toBe(false);

    const frozen = serviceWithAccount({ cashBalance: 10_000, status: 'frozen' });
    const result = await frozen.check({
      accountId: 'acct-1',
      estimatedCredits: 1,
      policy: 'accrue-and-track',
      ref: { type: 'container_reservation', id: 'c1' },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('ACCOUNT_FROZEN');
  });

  it('T-B5: accrue-and-track 永远放行但回传 insufficient', async () => {
    const account = serviceWithAccount({ cashBalance: 0 });
    const result = await account.check({
      accountId: 'acct-1',
      estimatedCredits: 100,
      policy: 'accrue-and-track',
      ref: { type: 'container_reservation', id: 'c2' },
    });
    expect(result.allowed).toBe(true);
    expect(result.insufficient).toBe(true);
  });

  it('T-B11: verify 校验凭证存在、accountId/ref 匹配', async () => {
    const account = serviceWithAccount({ cashBalance: 1000 });
    const result = await account.check({
      accountId: 'acct-1',
      estimatedCredits: 100,
      policy: 'accrue-and-track',
      ref: { type: 'model_call', id: 'r5' },
    });
    expect(() => account.verify(result.preCheck, { accountId: 'acct-1' })).not.toThrow();
    expect(() =>
      account.verify(result.preCheck, { accountId: 'acct-2' }),
    ).toThrow(/account mismatch/);
    expect(() =>
      account.verify(result.preCheck, {
        accountId: 'acct-1',
        ref: { type: 'model_call', id: 'other' },
      }),
    ).toThrow(/ref mismatch/);
    expect(() => account.verify('missing', { accountId: 'acct-1' })).toThrow(/required/);
  });
});
