import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { BillingAccount } from '../../models/billing-account.js';
import { BillingReservation } from '../../models/billing-reservation.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

vi.mock('../cloud-controller-client.js', () => ({
  cloudControllerClient: {
    list: vi.fn(async () => []),
    destroy: vi.fn(async () => true),
  },
}));

import { cloudControllerClient } from '../cloud-controller-client.js';
import { billingRuntime, reconciliationRuntime } from './instances.js';

describe('计费运行时单例', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
    vi.clearAllMocks();
  });

  it('强拆动作接到 cloud-controller（带 reason）', async () => {
    const account = await BillingAccount.create({
      ownerType: 'front_user',
      ownerId: 'u1',
      ownerName: 'alice',
      cashBalance: 0,
    });
    const now = new Date();
    await BillingReservation.create({
      accountId: account._id,
      resourceId: 'c-force',
      status: 'ACTIVE',
      depositCents: 0,
      cycleEstimateCents: 0,
      reservedTotal: 0,
      settledTotal: 0,
      releasedTotal: 0,
      startedAt: now,
      lastSettleAt: now,
      lastCycleSeq: -1,
      expectedEndAt: new Date(now.getTime() + 60_000),
    });
    const destroyed = await billingRuntime.forceDestroyAccountContainers(String(account._id));
    expect(destroyed).toBe(1);
    expect(cloudControllerClient.destroy).toHaveBeenCalledWith(
      'c-force',
      '余额不足超过 10 分钟，强制销毁',
    );
  });

  it('资源对账单例使用控制面容器列表', async () => {
    const reports = await reconciliationRuntime.run('resources');
    expect(reports[0].line).toBe('resources');
    expect(cloudControllerClient.list).toHaveBeenCalled();
  });
});
