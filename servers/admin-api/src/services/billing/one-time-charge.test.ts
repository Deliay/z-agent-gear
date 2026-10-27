import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BillingAccount } from '../../models/billing-account.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { BillingLedger } from '../../models/billing-ledger.js';
import { BillingPayment } from '../../models/billing-payment.js';
import { oneTimeChargeService, InsufficientBalanceError, AccountFrozenError } from './one-time-charge.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

describe('OneTimeChargeService（云电脑创建一次性扣费/退款）', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  async function account(cashBalance = 1000) {
    const doc = await BillingAccount.create({
      ownerType: 'front_user',
      ownerId: 'u1',
      ownerName: 'alice',
      cashBalance,
    });
    return String(doc._id);
  }

  const input = (accountId: string) => ({
    accountId,
    productId: 'cloud_host.create',
    quantity: 1,
    idempotentKey: 'cloud_host.create:h1',
    refType: 'cloud_host',
    refId: 'h1',
    description: '创建云电脑 test',
  });

  it('T-OTC1/T-OTC2: 扣费成功且同幂等键重复请求返回首单', async () => {
    const accountId = await account();
    const first = await oneTimeChargeService.createOneTimeCharge(input(accountId));
    expect(first.charged).toBe(true);
    expect((first.invoice as { amount: number }).amount).toBe(-500);
    expect((first.receipt as { id: string }).id).toBeTruthy();
    expect((await BillingAccount.findById(accountId))?.cashBalance).toBe(500);

    const second = await oneTimeChargeService.createOneTimeCharge(input(accountId));
    expect(String((second.invoice as { _id: unknown })._id)).toBe(
      String((first.invoice as { _id: unknown })._id),
    );
    expect(await BillingInvoice.countDocuments({ accountId })).toBe(1);
    expect(await BillingPayment.countDocuments({ accountId })).toBe(1);
  });

  it('T-OTC3: 余额不足拒绝且不产生任何账务记录', async () => {
    const accountId = await account(100);
    await expect(oneTimeChargeService.createOneTimeCharge(input(accountId))).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
    expect(await BillingInvoice.countDocuments()).toBe(0);
    expect(await BillingPayment.countDocuments()).toBe(0);
    expect(await BillingLedger.countDocuments()).toBe(0);
    expect((await BillingAccount.findById(accountId))?.cashBalance).toBe(100);
  });

  it('T-OTC4: 账户冻结拒绝且不产生账务记录', async () => {
    const accountId = await account();
    await BillingAccount.updateOne({ _id: accountId }, { $set: { status: 'frozen' } });
    await expect(oneTimeChargeService.createOneTimeCharge(input(accountId))).rejects.toBeInstanceOf(
      AccountFrozenError,
    );
    expect(await BillingInvoice.countDocuments()).toBe(0);
    expect(await BillingLedger.countDocuments()).toBe(0);
  });

  it('T-OTC5/T-OTC6: 退款写 adjust 正向账单、余额回升且同 refundKey 幂等', async () => {
    const accountId = await account();
    await oneTimeChargeService.createOneTimeCharge(input(accountId));
    const refunded = await oneTimeChargeService.refundCharge({
      idempotentKey: 'cloud_host.create:h1',
      refundKey: 'cloud_host.create.refund:h1',
      reason: 'start failed',
    });
    expect((refunded.invoice as { type: string; amount: number }).type).toBe('adjust');
    expect((refunded.invoice as { amount: number }).amount).toBe(500);
    expect((await BillingAccount.findById(accountId))?.cashBalance).toBe(1000);

    const again = await oneTimeChargeService.refundCharge({
      idempotentKey: 'cloud_host.create:h1',
      refundKey: 'cloud_host.create.refund:h1',
      reason: 'start failed',
    });
    expect(String((again.invoice as { _id: unknown })._id)).toBe(
      String((refunded.invoice as { _id: unknown })._id),
    );
    expect((await BillingAccount.findById(accountId))?.cashBalance).toBe(1000);
    expect(await BillingInvoice.countDocuments({ accountId, type: 'adjust' })).toBe(1);
  });

  it('T-OTC7: 原扣费不存在时退款幂等成功（返回空账单）', async () => {
    const result = await oneTimeChargeService.refundCharge({
      idempotentKey: 'cloud_host.create:missing',
      refundKey: 'cloud_host.create.refund:missing',
      reason: 'missing',
    });
    expect(result.invoice).toBeNull();
    expect(result.receipt).toBeNull();
  });

  it('T-OTC-PQ: price-quote 缺档回落默认价目', async () => {
    const items = await oneTimeChargeService.getPriceQuote([
      'cloud_host.create',
      'container.minute',
    ]);
    expect(items).toEqual([
      { productId: 'cloud_host.create', unitPrice: 5, currency: 'credits' },
      { productId: 'container.minute', unitPrice: 1, currency: 'credits' },
    ]);
  });
});
