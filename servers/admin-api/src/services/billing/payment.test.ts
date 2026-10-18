import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { BillingAccount } from '../../models/billing-account.js';
import { BillingLedger } from '../../models/billing-ledger.js';
import { CreditCheckService } from './credit-check.js';
import { PaymentService } from './payment.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

describe('PaymentService（冻结/解冻/扣费/充值幂等）', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  const checks = new CreditCheckService();

  async function account() {
    const doc = await BillingAccount.create({
      ownerType: 'front_user',
      ownerId: 'u1',
      ownerName: 'alice',
      cashBalance: 1000,
    });
    return String(doc._id);
  }

  function check(accountId: string) {
    return checks.check({
      accountId,
      estimatedCredits: 100,
      policy: 'accrue-and-track',
      ref: { type: 'model_call', id: 'r1' },
    });
  }

  it('freeze/unfreeze 幂等，冻结额不为负；0 金额为 no-op', async () => {
    const accountId = await account();
    const payments = new PaymentService(checks);
    const preCheck = (await check(accountId)).preCheck!;
    const frozen = await payments.freeze({
      accountId,
      amountCents: 300,
      bizId: 'b1',
      idempotentKey: 'f1',
      preCheck,
      ref: { type: 'model_call', id: 'r1' },
    });
    expect(frozen.applied).toBe(true);
    expect(frozen.frozenAmount).toBe(300);
    const again = await payments.freeze({
      accountId,
      amountCents: 300,
      bizId: 'b1',
      idempotentKey: 'f1',
      preCheck,
      ref: { type: 'model_call', id: 'r1' },
    });
    expect(again.applied).toBe(false);

    await payments.unfreeze({ accountId, amountCents: 500, bizId: 'b1', idempotentKey: 'u1' });
    expect((await BillingAccount.findById(accountId))?.frozenAmount).toBe(0);
    const unfreezeAgain = await payments.unfreeze({
      accountId,
      amountCents: 100,
      bizId: 'b1',
      idempotentKey: 'u1',
    });
    expect(unfreezeAgain.applied).toBe(false);

    const noop = await payments.freeze({
      accountId,
      amountCents: 0,
      bizId: 'b',
      idempotentKey: 'f0',
      preCheck,
    });
    expect(noop.applied).toBe(false);
    expect(await BillingLedger.countDocuments()).toBe(2);
  });

  it('charge 幂等；recharge 幂等；非法参数抛错', async () => {
    const accountId = await account();
    const payments = new PaymentService(checks);
    const preCheck = (await check(accountId)).preCheck!;
    const first = await payments.charge({
      accountId,
      amountCents: 250,
      idempotentKey: 'c1',
      bizId: 'b1',
      preCheck,
      ref: { type: 'model_call', id: 'r1' },
    });
    expect(first.applied).toBe(true);
    expect(first.cashBalance).toBe(750);
    const second = await payments.charge({
      accountId,
      amountCents: 250,
      idempotentKey: 'c1',
      bizId: 'b1',
      preCheck,
      ref: { type: 'model_call', id: 'r1' },
    });
    expect(second.applied).toBe(false);
    expect((await BillingAccount.findById(accountId))?.cashBalance).toBe(750);

    const recharged = await payments.recharge({
      accountId,
      amountCents: 500,
      idempotentKey: 'r1',
      bizId: 'r1',
    });
    expect(recharged.cashBalance).toBe(1250);
    const rechargeAgain = await payments.recharge({
      accountId,
      amountCents: 500,
      idempotentKey: 'r1',
      bizId: 'r1',
    });
    expect(rechargeAgain.applied).toBe(false);

    await expect(
      payments.charge({
        accountId,
        amountCents: -1,
        idempotentKey: 'neg',
        bizId: 'x',
        preCheck,
      }),
    ).rejects.toThrow();
    await expect(
      payments.recharge({ accountId, amountCents: 0, idempotentKey: 'zero', bizId: 'x' }),
    ).rejects.toThrow();
    await expect(
      payments.charge({
        accountId: new mongoose.Types.ObjectId().toHexString(),
        amountCents: 1,
        idempotentKey: 'missing-account',
        bizId: 'x',
        preCheck,
      }),
    ).rejects.toThrow();
  });
});
