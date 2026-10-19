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

  it('events: 已计费起点但事实事件缺失 → 反向补投 outbox', async () => {
    const { BillingOutbox } = await import('../../models/billing-outbox.js');
    const billing = { handleContainerDestroyed: vi.fn() };
    const recon = new ReconciliationService(billing as never, { list: vi.fn() } as never, {
      listContainers: async () => [
        {
          id: 'c-evt-1',
          status: 'exited',
          billingAccountId: 'acct-1',
          billingStartedAt: new Date('2026-10-01T00:00:00Z').toISOString(),
          exitedAt: new Date('2026-10-01T00:10:00Z').toISOString(),
        },
      ],
    });
    const [report] = await recon.run('events');
    expect(report.line).toBe('events');
    expect(report.checkedCount).toBe(1);
    expect(report.errorCount).toBe(2);
    expect(await BillingOutbox.countDocuments({})).toBe(2);
    expect(await BillingOutbox.countDocuments({ eventId: 'container.ready:c-evt-1' })).toBe(1);
    expect(await BillingOutbox.countDocuments({ eventId: 'container.destroyed:c-evt-1' })).toBe(1);
  });

  it('events: 已有事件/outbox 的不重复补投；未知 line 抛错', async () => {
    const recon = new ReconciliationService({} as never, { list: vi.fn() } as never, {
      listContainers: async () => [],
    });
    const [report] = await recon.run('events');
    expect(report.errorCount).toBe(0);
    await expect(recon.run('bogus')).rejects.toThrow(/unknown reconciliation line/);
  });

  it('resources: 容器存活时只上报 stale，不 finalize（A-3）', async () => {
    const billing = { handleContainerDestroyed: vi.fn().mockResolvedValue(null) };
    const reservations = {
      list: vi.fn().mockResolvedValue([
        {
          _id: 'r-alive',
          accountId: 'a1',
          resourceId: 'c-alive',
          status: 'ACTIVE',
          expectedEndAt: new Date(Date.now() - 60 * 60_000),
        },
      ]),
    };
    const recon = new ReconciliationService(billing as never, reservations as never, {
      listContainers: async () => [{ id: 'c-alive', status: 'online' }],
    });
    const [report] = await recon.run('resources');
    expect(billing.handleContainerDestroyed).not.toHaveBeenCalled();
    expect(report.errors[0]).toMatchObject({ reason: 'reservation_expired_but_container_alive' });
  });

  it('rollups: rollup 与账单真值漂移被报告（建议：汇总校准线）', async () => {
    const { BillingInvoice } = await import('../../models/billing-invoice.js');
    const { BillingRollup } = await import('../../models/billing-rollup.js');
    const account = await accountService.getOrCreate(
      'front_user',
      new mongoose.Types.ObjectId().toString(),
      'rollup-user',
    );
    await BillingInvoice.create({
      accountId: account.id,
      seq: 0,
      type: 'charge',
      category: 'model',
      amount: -100,
      balanceAfter: 0,
      description: 'drift',
      createdAt: new Date(),
    });
    await BillingRollup.create({
      accountId: account.id,
      granularity: 'hour',
      bucketStart: new Date(new Date().setUTCMinutes(0, 0, 0)),
      chargeTotal: 0,
      rechargeTotal: 0,
      chargeCount: 0,
    });
    const recon = new ReconciliationService({} as never, { list: vi.fn() } as never, {
      listContainers: async () => [],
    });
    const [report] = await recon.run('rollups');
    expect(report.line).toBe('rollups');
    expect(report.errorCount).toBe(1);
    expect(report.errors[0]).toMatchObject({ accountId: account.id, invoiceCharge: 100 });
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
