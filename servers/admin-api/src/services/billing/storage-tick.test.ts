import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { BillingAccount } from '../../models/billing-account.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { BillingPayment } from '../../models/billing-payment.js';
import { CloudStorageMirror } from '../../models/cloud-storage.js';
import { StorageBillingCursor } from '../../models/storage-billing-cursor.js';
import { pricingService } from './pricing.js';
import { StorageTickService } from './storage-tick.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-11-02T00:00:00.000Z');

describe('StorageTickService（T-BILL-S2/S3/S4/S5/S7）', () => {
  beforeAll(async () => {
    await connectTestDb();
    await pricingService.ensureDefaultPrices();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
    await pricingService.ensureDefaultPrices();
  });

  async function account(cashBalance = 1_000_000) {
    const doc = await BillingAccount.create({
      ownerType: 'tenant',
      ownerId: 'tenant-1',
      ownerName: 'tenant',
      cashBalance,
    });
    return String(doc._id);
  }

  async function storage(
    accountId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const doc = await CloudStorageMirror.create({
      name: 'my-data',
      sizeGi: 20,
      status: 'IDLE',
      billingRate: 'FULL',
      billingStartedAt: T0,
      billingAccountId: accountId,
      tenantId: new mongoose.Types.ObjectId(),
      ...overrides,
    });
    return String(doc._id);
  }

  function tickAt(ms: number) {
    return new StorageTickService({ now: () => ms });
  }

  it('T-BILL-S2: 首桶出账、跨桶补结算、单次 24 桶上限、剩余下次继续', async () => {
    const accountId = await account();
    const storageId = await storage(accountId);

    // 未满 1 小时：不出账，但游标已建立
    await tickAt(T0.getTime() + HOUR - 1).tick();
    expect(await BillingInvoice.countDocuments()).toBe(0);
    expect((await StorageBillingCursor.findOne({ storageId }))?.chargedHours).toBe(0);

    // 满 1 小时：首桶出账（20Gi FULL = 15 credits）
    const first = await tickAt(T0.getTime() + HOUR).tick();
    expect(first.chargedHours).toBe(1);
    const firstInvoice = await BillingInvoice.findOne({ refId: storageId }).lean();
    expect(firstInvoice?.amount).toBe(-1500);

    // 跨 3 小时：补齐 2 桶
    await tickAt(T0.getTime() + 3 * HOUR).tick();
    expect(await BillingInvoice.countDocuments({ refId: storageId })).toBe(3);

    // 30 小时：单次最多 24 桶（累计 27），剩余下次继续
    await tickAt(T0.getTime() + 30 * HOUR).tick();
    expect(await BillingInvoice.countDocuments({ refId: storageId })).toBe(27);
    expect((await StorageBillingCursor.findOne({ storageId }))?.chargedHours).toBe(27);

    await tickAt(T0.getTime() + 30 * HOUR).tick();
    expect(await BillingInvoice.countDocuments({ refId: storageId })).toBe(30);
    expect((await StorageBillingCursor.findOne({ storageId }))?.chargedHours).toBe(30);

    // 幂等键按桶末 epochHour 唯一
    const keys = await BillingPayment.find({ accountId }).lean();
    expect(new Set(keys.map((row) => row.idempotentKey)).size).toBe(30);
  });

  it('T-BILL-S3: 同 storageId + bucketEndEpochHour 重放不重复出账', async () => {
    const accountId = await account();
    const storageId = await storage(accountId);

    await tickAt(T0.getTime() + HOUR).tick();
    expect(await BillingInvoice.countDocuments({ refId: storageId })).toBe(1);

    // 模拟「已出账但游标未推进」的崩溃窗口：回拨 chargedHours 后重跑
    await StorageBillingCursor.updateOne({ storageId }, { $set: { chargedHours: 0 } });
    await tickAt(T0.getTime() + HOUR).tick();

    expect(await BillingInvoice.countDocuments({ refId: storageId })).toBe(1);
    expect(await BillingPayment.countDocuments({ accountId })).toBe(1);
    expect((await StorageBillingCursor.findOne({ storageId }))?.chargedHours).toBe(1);
    expect((await BillingAccount.findById(accountId))?.cashBalance).toBe(1_000_000 - 1500);
  });

  it('T-BILL-S4: 余额不足不推进 chargedHours 并记 lastError，充值后重试成功', async () => {
    const accountId = await account(100);
    const storageId = await storage(accountId);

    await tickAt(T0.getTime() + HOUR).tick();
    const cursor = await StorageBillingCursor.findOne({ storageId }).lean();
    expect(cursor?.chargedHours).toBe(0);
    expect(cursor?.lastError).toContain('insufficient balance');
    expect(await BillingInvoice.countDocuments()).toBe(0);

    await BillingAccount.updateOne({ _id: accountId }, { $set: { cashBalance: 10_000 } });
    await tickAt(T0.getTime() + HOUR).tick();

    const retried = await StorageBillingCursor.findOne({ storageId }).lean();
    expect(retried?.chargedHours).toBe(1);
    expect(retried?.lastError).toBeNull();
    expect(retried?.lastRate).toBe('FULL');
    expect(await BillingInvoice.countDocuments({ refId: storageId })).toBe(1);
  });

  it('T-BILL-S5: 销毁尾桶向上取整结算，随后 closedAt 非空且不再扫描', async () => {
    const accountId = await account();
    const storageId = await storage(accountId, { sizeGi: 10 });
    const destroyedAt = new Date(T0.getTime() + HOUR + 20 * 60 * 1000);
    await CloudStorageMirror.updateOne(
      { _id: storageId },
      { $set: { status: 'DESTROYED', destroyedAt } },
    );

    const result = await tickAt(T0.getTime() + 2 * HOUR).tick();
    expect(result.chargedHours).toBe(2); // ceil(80min / 60min) = 2
    expect(result.closed).toBe(1);
    const cursor = await StorageBillingCursor.findOne({ storageId }).lean();
    expect(cursor?.chargedHours).toBe(2);
    expect(cursor?.closedAt).toBeInstanceOf(Date);
    expect(await BillingInvoice.countDocuments({ refId: storageId })).toBe(2);

    // 已关账：不再扫描/出账
    const again = await tickAt(T0.getTime() + 10 * HOUR).tick();
    expect(again.scanned).toBe(0);
    expect(await BillingInvoice.countDocuments({ refId: storageId })).toBe(2);
  });

  it('T-BILL-S5: CREATE_FAILED（无 billingStartedAt）不计费', async () => {
    const accountId = await account();
    await CloudStorageMirror.create({
      name: 'failed',
      sizeGi: 10,
      status: 'CREATE_FAILED',
      billingRate: 'FULL',
      billingStartedAt: null,
      destroyedAt: new Date(T0.getTime() + HOUR),
      billingAccountId: accountId,
    });
    const result = await tickAt(T0.getTime() + 3 * HOUR).tick();
    expect(result.scanned).toBe(0);
    expect(await BillingInvoice.countDocuments()).toBe(0);
    expect(await StorageBillingCursor.countDocuments()).toBe(0);
  });

  it('T-BILL-S7: FULL 桶与 HALF 桶分别按结算时刻费率出账', async () => {
    const accountId = await account();
    const storageId = await storage(accountId, { sizeGi: 10 });

    await tickAt(T0.getTime() + HOUR).tick();
    await CloudStorageMirror.updateOne(
      { _id: storageId },
      { $set: { status: 'ARCHIVED', billingRate: 'HALF' } },
    );
    await tickAt(T0.getTime() + 2 * HOUR).tick();

    const invoices = await BillingInvoice.find({ refId: storageId }).sort({ seq: 1 }).lean();
    expect(invoices.map((invoice) => invoice.amount)).toEqual([-500, -250]);
    expect(invoices[1]?.description).toContain('（归档半价）');
    expect(invoices[1]?.items[0]?.unitPrice).toBe(250);
    expect((await StorageBillingCursor.findOne({ storageId }))?.lastRate).toBe('HALF');
  });

  it('游标按 storageId 唯一 upsert（重复 tick 不产生重复游标）', async () => {
    const accountId = await account();
    const storageId = await storage(accountId);
    await tickAt(T0.getTime() + HOUR).tick();
    await tickAt(T0.getTime() + 2 * HOUR).tick();
    expect(await StorageBillingCursor.countDocuments({ storageId })).toBe(1);
  });
});
