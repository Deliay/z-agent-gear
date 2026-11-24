import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { BillingAccount } from '../../models/billing-account.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { CloudBillingCursor } from '../../models/cloud-billing-cursor.js';
import { pricingService } from './pricing.js';
import { SpecTickService } from './spec-tick.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const T0 = new Date('2026-11-24T00:00:00.000Z');
const RESOURCE_ID = '507f1f77bcf86cd7994390c1';
const HOST_ID = '507f1f77bcf86cd7994390c2';

const SPEC_8C16G20G = {
  specId: '507f1f77bcf86cd7994390b1',
  specName: '8C 16G 20G',
  specCpu: 8,
  specMemoryGi: 16,
  specEphemeralStorageGi: 20,
};

describe('SpecTickService（T-SPT 小时桶结算）', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
    await pricingService.ensureDefaultPrices();
  });

  async function account(cashBalance = 10_000_000) {
    const doc = await BillingAccount.create({
      ownerType: 'tenant',
      ownerId: 'tenant-1',
      ownerName: 'tenant',
      cashBalance,
    });
    return String(doc._id);
  }

  async function cursor(accountId: string, overrides: Record<string, unknown> = {}) {
    await CloudBillingCursor.create({
      resourceId: RESOURCE_ID,
      hostId: HOST_ID,
      hostName: 'my-cloud',
      accountId: new mongoose.Types.ObjectId(accountId),
      tenantId: 'tenant-1',
      ...SPEC_8C16G20G,
      billingStartedAt: T0,
      chargedMinutes: 0,
      ...overrides,
    });
  }

  function tickAt(ms: number) {
    return new SpecTickService({ now: () => ms });
  }

  it('T-SPT1: 未满 1 小时不出账；满 1 小时按桶末价目出账 820 credits', async () => {
    const accountId = await account();
    await cursor(accountId);

    await tickAt(T0.getTime() + HOUR - 1).tick();
    expect(await BillingInvoice.countDocuments()).toBe(0);

    const first = await tickAt(T0.getTime() + HOUR).tick();
    expect(first.chargedHours).toBe(1);
    const invoice = await BillingInvoice.findOne({ refId: HOST_ID }).lean();
    expect(invoice?.amount).toBe(-82_000);
    expect(invoice?.category).toBe('container');
    expect(invoice?.refType).toBe('cloud_host');
    const items = (invoice?.items ?? []) as Array<{ amount: number }>;
    expect(items.reduce((acc, item) => acc + item.amount, 0)).toBe(82_000);
    expect((await CloudBillingCursor.findOne({ resourceId: RESOURCE_ID }))?.chargedMinutes).toBe(60);
  });

  it('T-SPT2: 单次 tick 最多补 24 桶，剩余下次继续', async () => {
    const accountId = await account();
    await cursor(accountId);
    const result = await tickAt(T0.getTime() + 30 * HOUR).tick();
    expect(result.chargedHours).toBe(24);
    expect(await BillingInvoice.countDocuments({ refId: HOST_ID })).toBe(24);
    expect((await CloudBillingCursor.findOne({ resourceId: RESOURCE_ID }))?.chargedMinutes).toBe(
      24 * 60,
    );
  });

  it('T-SPT3: 幂等重放（同桶不重复出账）', async () => {
    const accountId = await account();
    await cursor(accountId);
    await tickAt(T0.getTime() + 3 * HOUR).tick();
    await tickAt(T0.getTime() + 3 * HOUR).tick();
    expect(await BillingInvoice.countDocuments({ refId: HOST_ID })).toBe(3);
    expect((await CloudBillingCursor.findOne({ resourceId: RESOURCE_ID }))?.chargedMinutes).toBe(180);
  });

  it('T-SPT4/5/6: 销毁尾段分钟折算、尾段至多一次、closedAt 收口', async () => {
    const accountId = await account();
    await cursor(accountId);
    const exitedAt = new Date(T0.getTime() + HOUR + 20 * MINUTE + 30_000); // 1h20m30s
    const service = tickAt(T0.getTime() + 2 * HOUR);
    const result = await service.settleTail(RESOURCE_ID, exitedAt);
    expect(result.closed).toBe(true);

    // 1 个整桶（82000）+ 尾段 ceil(20.5)=21 分钟（82000×21/60 向上取整到分）
    expect(await BillingInvoice.countDocuments({ refId: HOST_ID })).toBe(2);
    const tail = await BillingInvoice.findOne({ description: /尾段折算/ }).lean();
    expect(tail?.amount).toBe(-Math.ceil((82_000 * 21) / 60));
    const row = await CloudBillingCursor.findOne({ resourceId: RESOURCE_ID }).lean();
    expect(row?.closedAt).not.toBeNull();
    expect(row?.chargedMinutes).toBe(60 + 21);

    // 尾段至多一次：重放不再出账
    const replay = await service.settleTail(RESOURCE_ID, exitedAt);
    expect(replay.closed).toBe(true);
    expect(await BillingInvoice.countDocuments({ refId: HOST_ID })).toBe(2);
  });

  it('T-SPT7: 余额不足记 lastError + markInsufficient，下个 tick 重试', async () => {
    const accountId = await account(0);
    await cursor(accountId);
    await tickAt(T0.getTime() + HOUR).tick();
    expect(await BillingInvoice.countDocuments()).toBe(0);
    const row = await CloudBillingCursor.findOne({ resourceId: RESOURCE_ID }).lean();
    expect(row?.closedAt).toBeNull();
    expect(row?.lastError).toBeTruthy();
    expect((await BillingAccount.findById(accountId).lean())?.insufficientSince).not.toBeNull();

    // 充值后下一个 tick 补齐同一桶（幂等键未占用）
    await BillingAccount.updateOne({ _id: accountId }, { $set: { cashBalance: 10_000_000 } });
    await tickAt(T0.getTime() + 2 * HOUR).tick();
    expect(await BillingInvoice.countDocuments({ refId: HOST_ID })).toBe(2);
  });

  it('T-SPT8: 0C 0G 全零规格走新路径但不出账，销毁后仍收口', async () => {
    const accountId = await account();
    await cursor(accountId, {
      specId: '507f1f77bcf86cd7994390b2',
      specName: '0C 0G 0G',
      specCpu: 0,
      specMemoryGi: 0,
      specEphemeralStorageGi: 0,
    });
    await tickAt(T0.getTime() + 3 * HOUR).tick();
    expect(await BillingInvoice.countDocuments()).toBe(0);
    expect((await CloudBillingCursor.findOne({ resourceId: RESOURCE_ID }))?.chargedMinutes).toBe(180);

    const result = await tickAt(T0.getTime() + 4 * HOUR).settleTail(
      RESOURCE_ID,
      new Date(T0.getTime() + 3 * HOUR + 10 * MINUTE),
    );
    expect(result.closed).toBe(true);
    expect(await BillingInvoice.countDocuments()).toBe(0);
    expect((await CloudBillingCursor.findOne({ resourceId: RESOURCE_ID }))?.closedAt).not.toBeNull();
  });

  it('T-SPT9: 销毁尾段事件缺失 exitedAt 时以事件时刻兜底（settleTail 入参）', async () => {
    const accountId = await account();
    await cursor(accountId);
    const eventAt = new Date(T0.getTime() + HOUR + 5 * MINUTE);
    const result = await tickAt(T0.getTime() + 2 * HOUR).settleTail(RESOURCE_ID, eventAt);
    expect(result.closed).toBe(true);
    const tail = await BillingInvoice.findOne({ description: /尾段折算/ }).lean();
    expect(tail?.amount).toBe(-Math.ceil((82_000 * 5) / 60));
  });
});
