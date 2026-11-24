import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { BillingAccount } from '../../models/billing-account.js';
import { CloudBillingCursor } from '../../models/cloud-billing-cursor.js';
import { CloudContainer } from '../../models/cloud-container.js';
import { BillingEvent } from '../../models/billing-event.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { BillingService } from './billing-service.js';
import { pricingService } from './pricing.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

const T0 = new Date('2026-11-24T00:00:00.000Z');
const RESOURCE_ID = '507f1f77bcf86cd7994390d1';
const HOST_ID = '507f1f77bcf86cd7994390d2';

describe('BillingService 规格分流（T-SP-API5）', () => {
  const service = new BillingService();

  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
    await pricingService.ensureDefaultPrices();
    await CloudContainer.create({
      _id: RESOURCE_ID,
      name: 'zag-worker-spec',
      namespace: 'zag-cloud',
      purpose: 'harness',
      image: 'worker:latest',
      hostId: HOST_ID,
      hostName: 'my-cloud',
    });
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

  it('带 spec → 建 cloudbillingcursors 游标（不进预留路径），hostId 由镜像解析', async () => {
    const accountId = await account();
    const result = await service.handleContainerReady({
      accountId,
      resourceId: RESOURCE_ID,
      occurredAt: T0,
      payload: {
        billingStartedAt: T0.toISOString(),
        spec: {
          specId: 'spec-1',
          name: '8C 16G 20G',
          cpu: 8,
          memoryGi: 16,
          ephemeralStorageGi: 20,
        },
      },
    });
    expect(result.created).toBe(true);
    const cursor = await CloudBillingCursor.findOne({ resourceId: RESOURCE_ID }).lean();
    expect(cursor?.hostId).toBe(HOST_ID);
    expect(cursor?.specId).toBe('spec-1');
    expect(cursor?.specCpu).toBe(8);
    expect(cursor?.billingStartedAt).toEqual(T0);
  });

  it('重复 ready 幂等（不重复建游标）', async () => {
    const accountId = await account();
    const event = {
      accountId,
      resourceId: RESOURCE_ID,
      occurredAt: T0,
      payload: {
        billingStartedAt: T0.toISOString(),
        spec: { specId: 'spec-1', name: 'x', cpu: 4, memoryGi: 8, ephemeralStorageGi: 20 },
      },
    };
    await service.handleContainerReady(event);
    const second = await service.handleContainerReady(event);
    expect(second.created).toBe(false);
    expect(await CloudBillingCursor.countDocuments({ resourceId: RESOURCE_ID })).toBe(1);
  });

  it('有游标 → destroyed 尾段折算并 closedAt 收口（0C 0G 不出账）', async () => {
    const accountId = await account();
    await service.handleContainerReady({
      accountId,
      resourceId: RESOURCE_ID,
      occurredAt: T0,
      payload: {
        billingStartedAt: T0.toISOString(),
        spec: { specId: 'spec-0', name: '0C 0G 0G', cpu: 0, memoryGi: 0, ephemeralStorageGi: 0 },
      },
    });
    const exitedAt = new Date(T0.getTime() + 5 * 60 * 1000);
    await service.handleContainerDestroyed({
      accountId,
      resourceId: RESOURCE_ID,
      occurredAt: exitedAt,
      payload: { billingStartedAt: T0.toISOString(), exitedAt: exitedAt.toISOString() },
    });
    const cursor = await CloudBillingCursor.findOne({ resourceId: RESOURCE_ID }).lean();
    expect(cursor?.closedAt).not.toBeNull();
    expect(cursor?.chargedMinutes).toBe(5);
    expect(await BillingInvoice.countDocuments()).toBe(0);
  });

  it('乱序：destroyed 先到（legacy 无账单）→ 迟到 ready 带 spec 不再建游标', async () => {
    const accountId = await account();
    await BillingEvent.create({
      eventId: 'container.destroyed:pre',
      eventType: 'container.destroyed',
      occurredAt: T0,
      accountId,
      resourceId: RESOURCE_ID,
      payload: {},
      metered: false,
      receivedAt: T0,
    });
    const result = await service.handleContainerReady({
      accountId,
      resourceId: RESOURCE_ID,
      occurredAt: T0,
      payload: {
        billingStartedAt: T0.toISOString(),
        spec: { specId: 'spec-1', name: 'x', cpu: 4, memoryGi: 8, ephemeralStorageGi: 20 },
      },
    });
    expect(result.skipped).toBe(true);
    expect(await CloudBillingCursor.countDocuments({ resourceId: RESOURCE_ID })).toBe(0);
  });

  it('不带 spec → 旧预留路径（不建规格游标）', async () => {
    const accountId = await account();
    const result = await service.handleContainerReady({
      accountId,
      resourceId: RESOURCE_ID,
      occurredAt: T0,
      payload: { billingStartedAt: T0.toISOString() },
    });
    expect(result.created).toBe(true);
    expect(await CloudBillingCursor.countDocuments({ resourceId: RESOURCE_ID })).toBe(0);
  });

  it('非法 spec 载荷回落旧预留路径（不抛错）', async () => {
    const accountId = await account();
    const result = await service.handleContainerReady({
      accountId,
      resourceId: RESOURCE_ID,
      occurredAt: T0,
      payload: {
        billingStartedAt: T0.toISOString(),
        spec: { cpu: 0, memoryGi: 8, ephemeralStorageGi: 20 },
      },
    });
    expect(result.created).toBe(true);
    expect(await CloudBillingCursor.countDocuments({ resourceId: RESOURCE_ID })).toBe(0);
  });
});
