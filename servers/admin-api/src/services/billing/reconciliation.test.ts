import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { BillingEvent } from '../../models/billing-event.js';
import { BillingAccount } from '../../models/billing-account.js';
import { BillingLedger } from '../../models/billing-ledger.js';
import { accountService } from './account-service.js';
import { ReconciliationService } from './reconciliation.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

describe('ReconciliationService（三线对账）', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  it('funds: 分页遍历全部账户并校准漂移', async () => {
    const account = await accountService.getOrCreate(
      'front_user',
      new mongoose.Types.ObjectId().toString(),
      'alice',
    );
    await BillingLedger.create({
      accountId: account.id,
      pool: 'cash',
      bizType: 'recharge',
      deltaBalance: 100,
      idempotentKey: 'k1',
    });
    await BillingAccount.updateOne({ _id: account.id }, { $set: { cashBalance: 999 } });
    const billing = { handleContainerDestroyed: vi.fn() };
    const recon = new ReconciliationService(billing as never, { list: vi.fn() } as never, {
      accounts: accountService,
      listContainers: async () => [],
    });
    const [report] = await recon.run('funds');
    expect(report.line).toBe('funds');
    expect(report.checkedCount).toBe(1);
    expect(report.errorCount).toBe(1);
    expect((await accountService.getById(account.id))?.cashBalance).toBe(100);
    expect(recon.latest('funds')).toHaveLength(1);
    expect(recon.latest()).toHaveLength(1);
  });

  it('metering: 超时未计量事件被报告', async () => {
    await BillingEvent.create({
      eventId: 'evt-1',
      eventType: 'container.ready',
      occurredAt: new Date(Date.now() - 10 * 60_000),
      accountId: 'a1',
      resourceId: 'c1',
      payload: {},
      metered: false,
      receivedAt: new Date(Date.now() - 10 * 60_000),
    });
    const recon = new ReconciliationService({} as never, { list: vi.fn() } as never, {
      listContainers: async () => [],
    });
    const [report] = await recon.run('metering');
    expect(report.errorCount).toBe(1);
    expect(report.errors[0]).toMatchObject({ eventId: 'evt-1' });
  });

  it('resources: 容器缺失/超期 → 最终结算；列表失败 → 中止', async () => {
    const billing = { handleContainerDestroyed: vi.fn().mockResolvedValue(null) };
    const reservations = {
      list: vi.fn().mockResolvedValue([
        {
          _id: 'r1',
          accountId: 'a1',
          resourceId: 'c1',
          status: 'ACTIVE',
          expectedEndAt: null,
        },
      ]),
    };
    const missing = new ReconciliationService(billing as never, reservations as never, {
      listContainers: async () => [],
    });
    const [missingReport] = await missing.run('resources');
    expect(missingReport.errorCount).toBe(1);
    expect(billing.handleContainerDestroyed).toHaveBeenCalled();

    billing.handleContainerDestroyed.mockClear();
    const failed = new ReconciliationService(billing as never, reservations as never, {
      listContainers: async () => {
        throw new Error('down');
      },
    });
    const [failedReport] = await failed.run('resources');
    expect(failedReport.errors[0]).toMatchObject({ error: 'list_containers_failed' });
    expect(billing.handleContainerDestroyed).not.toHaveBeenCalled();
  });
});
