import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { BillingAccount } from '../../models/billing-account.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { InvoicingService } from './invoicing.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

describe('InvoicingService', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  it('幂等键/显式 invoiceId 重复创建返回同一账单，不重复占号', async () => {
    const account = await BillingAccount.create({
      ownerType: 'front_user',
      ownerId: 'u1',
      ownerName: 'alice',
      cashBalance: 1000,
    });
    const accountId = String(account._id);
    const invoicing = new InvoicingService();
    const invoiceId = new mongoose.Types.ObjectId().toHexString();
    const input = {
      accountId,
      type: 'charge' as const,
      category: 'container' as const,
      amount: -100,
      balanceAfter: 900,
      description: 'x',
      idempotentKey: 'invoice:k1',
      invoiceId,
    };
    const first = await invoicing.createInvoice(input);
    const second = await invoicing.createInvoice(input);
    expect(String(first._id)).toBe(String(second._id));
    expect(second.seq).toBe(0);
    expect(await BillingInvoice.countDocuments({ accountId })).toBe(1);
    // 账户 seq 只推进一次
    expect((await BillingAccount.findById(accountId))?.invoiceSeq).toBe(1);
  });

  it('rollup 失败不影响出账', async () => {
    const account = await BillingAccount.create({
      ownerType: 'front_user',
      ownerId: 'u2',
      ownerName: 'bob',
    });
    const rollups = {
      recordInvoice: vi.fn(async () => {
        throw new Error('rollup down');
      }),
    };
    const invoicing = new InvoicingService(rollups as never);
    const invoice = await invoicing.createInvoice({
      accountId: String(account._id),
      type: 'recharge',
      category: 'manual',
      amount: 1000,
      balanceAfter: 1000,
      description: 'recharge',
    });
    expect(invoice.seq).toBe(0);
    expect(rollups.recordInvoice).toHaveBeenCalled();
  });

  it('seq 竞争（E11000）后重试分配，最终成功且号码连续', async () => {
    const account = await BillingAccount.create({
      ownerType: 'front_user',
      ownerId: 'u3',
      ownerName: 'carol',
    });
    const invoicing = new InvoicingService();
    const spy = vi
      .spyOn(BillingInvoice, 'create')
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));
    const invoice = await invoicing.createInvoice({
      accountId: String(account._id),
      type: 'charge',
      category: 'manual',
      amount: -1,
      balanceAfter: 0,
      description: 'retry',
      idempotentKey: 'invoice:retry',
    });
    expect(invoice.seq).toBe(1);
    spy.mockRestore();
    expect(await BillingInvoice.countDocuments({ accountId: account._id })).toBe(1);
  });

  it('账户不存在/非法 ID 抛错', async () => {
    const invoicing = new InvoicingService();
    await expect(
      invoicing.createInvoice({
        accountId: 'not-an-object-id',
        type: 'charge',
        category: 'manual',
        amount: -1,
        balanceAfter: 0,
        description: 'x',
      }),
    ).rejects.toThrow();
    await expect(
      invoicing.createInvoice({
        accountId: new mongoose.Types.ObjectId().toHexString(),
        type: 'charge',
        category: 'manual',
        amount: -1,
        balanceAfter: 0,
        description: 'x',
      }),
    ).rejects.toThrow();
  });
});
