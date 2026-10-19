import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { BillingReceipt } from '../../models/billing-receipt.js';
import { receiptService } from './receipt.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

describe('ReceiptService', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  it('收据号格式 + 幂等（同一 receiptId 重复出具不重复落库）', async () => {
    const accountId = new mongoose.Types.ObjectId().toString();
    const invoiceId = new mongoose.Types.ObjectId().toString();
    const receiptId = new mongoose.Types.ObjectId().toString();
    const first = await receiptService.issueReceipt({
      receiptId,
      invoiceId,
      accountId,
      amount: 100,
      balanceAfter: 900,
      seq: 0,
      issuedAt: new Date('2026-10-01T00:00:00Z'),
    });
    expect(first.id).toBe(receiptId);
    expect(first.receiptNo).toMatch(/^R20261001/);

    const second = await receiptService.issueReceipt({
      receiptId,
      invoiceId,
      accountId,
      amount: 100,
      balanceAfter: 900,
      seq: 0,
    });
    expect(second.id).toBe(receiptId);
    expect(await BillingReceipt.countDocuments()).toBe(1);
  });
});
