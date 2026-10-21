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
    const reservations = { findByResource: vi.fn().mockResolvedValue(null), list: vi.fn() };
    const recon = new ReconciliationService(billing as never, reservations as never, {
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
    const recon = new ReconciliationService(
      {} as never,
      { findByResource: vi.fn().mockResolvedValue(null), list: vi.fn() } as never,
      { listContainers: async () => [] },
    );
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
    const recon = new ReconciliationService(
      {} as never,
      { findByResource: vi.fn().mockResolvedValue(null), list: vi.fn() } as never,
      { listContainers: async () => [] },
    );
    const [report] = await recon.run('rollups');
    expect(report.line).toBe('rollups');
    expect(report.errorCount).toBe(1);
    expect(report.errors[0]).toMatchObject({ accountId: account.id, invoiceCharge: 100 });
  });

  it('rollups: 小时桶边界对齐（floor_hour(from) 桶不再被误排除）— R3-7/8.4#1', async () => {
    const { BillingInvoice } = await import('../../models/billing-invoice.js');
    const { BillingRollup } = await import('../../models/billing-rollup.js');
    const account = await accountService.getOrCreate(
      'front_user',
      new mongoose.Types.ObjectId().toString(),
      'rollup-boundary-user',
    );
    // now 落在小时中段：from = now-24h 也落在小时中段，floor_hour(from) 桶起点 < from。
    const now = new Date('2026-10-02T12:34:56Z');
    const bucketStart = new Date('2026-10-01T12:00:00Z'); // floor_hour(now-24h)
    // 账单落在 [floor_hour(from), from] 之后的同一小时桶内 → 修复前 rollup 桶被排除、账单被计入 → 误报漂移。
    await BillingInvoice.create({
      accountId: account.id,
      seq: 0,
      type: 'charge',
      category: 'model',
      amount: -100,
      balanceAfter: 0,
      description: 'boundary',
      createdAt: new Date('2026-10-01T12:40:00Z'),
    });
    await BillingRollup.create({
      accountId: account.id,
      granularity: 'hour',
      bucketStart,
      chargeTotal: 100,
      rechargeTotal: 0,
      chargeCount: 1,
    });
    const recon = new ReconciliationService(
      {} as never,
      { findByResource: vi.fn().mockResolvedValue(null), list: vi.fn() } as never,
      { now: () => now.getTime(), listContainers: async () => [] },
    );
    const [report] = await recon.run('rollups');
    expect(report.line).toBe('rollups');
    // 对齐后 rollup 与账单都被纳入同一窗口 → 一致，无漂移（修复前会误报 1 条）。
    expect(report.errorCount).toBe(0);
  });

  it('events: 隔离行(failed:true) 必须补投（重置为 pending）而非视为已投递', async () => {
    const { BillingOutbox } = await import('../../models/billing-outbox.js');
    const startedAt = new Date('2026-10-01T00:00:00Z').toISOString();
    const exitedAt = new Date('2026-10-01T00:10:00Z').toISOString();
    await BillingOutbox.create({
      eventId: 'container.ready:c-iso',
      producer: 'cloud-controller',
      eventType: 'container.ready',
      routingKey: 'container.ready',
      payload: { eventId: 'container.ready:c-iso', eventType: 'container.ready', occurredAt: startedAt, accountId: 'a1', resourceId: 'c-iso', payload: { billingStartedAt: startedAt } },
      published: false,
      failed: true,
      attempts: 20,
    });
    await BillingOutbox.create({
      eventId: 'container.destroyed:c-iso',
      producer: 'cloud-controller',
      eventType: 'container.destroyed',
      routingKey: 'container.destroyed',
      payload: { eventId: 'container.destroyed:c-iso', eventType: 'container.destroyed', occurredAt: exitedAt, accountId: 'a1', resourceId: 'c-iso', payload: { billingStartedAt: startedAt, exitedAt } },
      published: false,
      failed: true,
      attempts: 20,
    });

    const reservations = { findByResource: vi.fn().mockResolvedValue(null), list: vi.fn() };
    const recon = new ReconciliationService({} as never, reservations as never, {
      listContainers: async () => [
        { id: 'c-iso', status: 'exited', billingAccountId: 'a1', billingStartedAt: startedAt, exitedAt },
      ],
    });
    const [report] = await recon.run('events');
    expect(report.errorCount).toBe(2);
    for (const eventId of ['container.ready:c-iso', 'container.destroyed:c-iso']) {
      const row = (await BillingOutbox.findOne({ eventId }).lean()) as {
        failed?: boolean;
        published?: boolean;
        attempts?: number;
      } | null;
      expect(row?.failed).toBe(false);
      expect(row?.published).toBe(false);
      expect(row?.attempts).toBe(0);
    }
  });

  it('events: 已发布未生效（DLQ）→ 代偿 eventId 重新入列；连续两轮 repair 行数收敛', async () => {
    const { BillingOutbox } = await import('../../models/billing-outbox.js');
    const startedAt = new Date('2026-10-01T00:00:00Z').toISOString();
    const exitedAt = new Date('2026-10-01T00:10:00Z').toISOString();
    await BillingOutbox.create({
      eventId: 'container.ready:c-dlq',
      producer: 'cloud-controller',
      eventType: 'container.ready',
      routingKey: 'container.ready',
      payload: {},
      published: true,
      failed: false,
    });
    await BillingOutbox.create({
      eventId: 'container.destroyed:c-dlq',
      producer: 'cloud-controller',
      eventType: 'container.destroyed',
      routingKey: 'container.destroyed',
      payload: {},
      published: true,
      failed: false,
    });

    const reservations = { findByResource: vi.fn().mockResolvedValue(null), list: vi.fn() };
    const nowValue = { value: 1234567890 };
    const make = () =>
      new ReconciliationService({} as never, reservations as never, {
        now: () => nowValue.value,
        listContainers: async () => [
          { id: 'c-dlq', status: 'exited', billingAccountId: 'a1', billingStartedAt: startedAt, exitedAt },
        ],
      });
    await make().run('events');
    expect(await BillingOutbox.countDocuments({ eventId: /^container\.ready:c-dlq:repair:/ })).toBe(1);
    expect(
      await BillingOutbox.countDocuments({ eventId: /^container\.destroyed:c-dlq:repair:/ }),
    ).toBe(1);

    // R3-2：第二轮（now 前进 → repair eventId 会不同）不得再新增——`repairOf` 护栏保证每个源事件至多补投一次。
    nowValue.value += 5_000;
    await make().run('events');
    expect(await BillingOutbox.countDocuments({ eventId: /^container\.ready:c-dlq:repair:/ })).toBe(1);
    expect(
      await BillingOutbox.countDocuments({ eventId: /^container\.destroyed:c-dlq:repair:/ }),
    ).toBe(1);
    expect(await BillingOutbox.countDocuments({ repairOf: { $ne: null } })).toBe(2);
  });

  it('events: FAILED 预留与零计费窗口的 destroyed 判终态不补投（R3-2/R4-2 收敛护栏）', async () => {
    const { BillingOutbox } = await import('../../models/billing-outbox.js');
    const reservations = {
      findByResource: vi.fn(async (rid: string) => (rid === 'c-failed' ? { status: 'FAILED' } : null)),
      list: vi.fn(),
    };
    // 零窗容器预置一条「已发布未生效」（DLQ）的 ready 行：若无 `repairOf` 护栏，第二轮会再插一条代偿行。
    await BillingOutbox.create({
      eventId: 'container.ready:c-zero',
      producer: 'cloud-controller',
      eventType: 'container.ready',
      routingKey: 'container.ready',
      payload: {
        eventId: 'container.ready:c-zero',
        eventType: 'container.ready',
        occurredAt: '2026-10-01T00:10:00Z',
        accountId: 'a1',
        resourceId: 'c-zero',
        payload: {},
      },
      published: true,
      failed: false,
    });
    const nowValue = { value: 1000 };
    const make = () =>
      new ReconciliationService({} as never, reservations as never, {
        now: () => nowValue.value,
        listContainers: async () => [
          {
            id: 'c-failed',
            status: 'exited',
            billingAccountId: 'a1',
            billingStartedAt: '2026-10-01T00:00:00Z',
            exitedAt: '2026-10-01T00:10:00Z',
          },
          {
            id: 'c-zero',
            status: 'exited',
            billingAccountId: 'a1',
            billingStartedAt: '2026-10-01T00:10:00Z',
            exitedAt: '2026-10-01T00:10:00Z',
          },
        ],
      });
    await make().run('events');
    nowValue.value += 5_000;
    await make().run('events');
    // 业务事实：两个资源都不应产生**任何** destroyed 补投行（FAILED 终态 / 零计费窗口判终态）。
    // 断言以事件 entity 为准（`^container.destroyed:`），修复前会补投 2 条朴素行 → 变红。
    expect(await BillingOutbox.countDocuments({ eventId: /^container\.destroyed:/ })).toBe(0);
    // ready 有界性由 `repairOf` 护栏锚定：原行 + 至多一条代偿行，第二轮不再新增（修复前第二轮新增第三条）。
    expect(await BillingOutbox.countDocuments({ eventId: /^container\.ready:c-zero/ })).toBe(2);
    expect(await BillingOutbox.countDocuments({ repairOf: 'container.ready:c-zero' })).toBe(1);
  });

  it('events: 在途(published:false, failed:false) 不重复补投', async () => {
    const { BillingOutbox } = await import('../../models/billing-outbox.js');
    const startedAt = new Date('2026-10-01T00:00:00Z').toISOString();
    await BillingOutbox.create({
      eventId: 'container.ready:c-flight',
      producer: 'cloud-controller',
      eventType: 'container.ready',
      routingKey: 'container.ready',
      payload: {},
      published: false,
      failed: false,
    });
    const reservations = { findByResource: vi.fn().mockResolvedValue(null), list: vi.fn() };
    const recon = new ReconciliationService({} as never, reservations as never, {
      listContainers: async () => [
        { id: 'c-flight', status: 'online', billingAccountId: 'a1', billingStartedAt: startedAt },
      ],
    });
    const [report] = await recon.run('events');
    expect(report.errorCount).toBe(0);
    expect(await BillingOutbox.countDocuments({ eventId: /repair:/ })).toBe(0);
  });

  it('apiCalls: cost>0 但无 invoiceSeq 的调用被报告（A-4 对账线）', async () => {
    const { BillingApiCall } = await import('../../models/billing-api-call.js');
    const account = await accountService.getOrCreate(
      'front_user',
      new mongoose.Types.ObjectId().toString(),
      'api-call-user',
    );
    await BillingApiCall.create({
      requestId: 'req-drift',
      accountId: account.id,
      apiKeyId: new mongoose.Types.ObjectId(),
      modelId: 'gpt-5',
      cost: 42,
      status: 'completed',
      invoiceSeq: null,
      finishedAt: new Date(),
    });
    const recon = new ReconciliationService(
      { handleContainerDestroyed: vi.fn() } as never,
      { list: vi.fn() } as never,
      { listContainers: async () => [] },
    );
    const [report] = await recon.run('apiCalls');
    expect(report.line).toBe('apiCalls');
    expect(report.errorCount).toBe(1);
    expect(report.errors[0]).toMatchObject({
      requestId: 'req-drift',
      reason: 'cost_without_invoice',
      repair: 'injected',
    });
    const { BillingOutbox } = await import('../../models/billing-outbox.js');
    expect(await BillingOutbox.countDocuments({ eventId: 'model_call.completed:req-drift' })).toBe(1);
  });

  it('R10-3/R10-4: model_call 隔离行复位，started 孤儿调用被报告', async () => {
    const { BillingApiCall } = await import('../../models/billing-api-call.js');
    const { BillingOutbox } = await import('../../models/billing-outbox.js');
    const account = await accountService.getOrCreate(
      'front_user',
      new mongoose.Types.ObjectId().toString(),
      'orphan-user',
    );
    await BillingOutbox.create({
      eventId: 'model_call.completed:req-quarantined',
      producer: 'admin-api',
      eventType: 'model_call.completed',
      routingKey: 'model_call.completed',
      payload: {},
      published: false,
      failed: true,
      attempts: 20,
    });
    await BillingApiCall.create({
      requestId: 'req-orphan',
      accountId: account.id,
      apiKeyId: new mongoose.Types.ObjectId(),
      modelId: 'gpt-5',
      cost: 0,
      status: 'started',
      invoiceSeq: null,
      startedAt: new Date(Date.now() - 60 * 60_000),
    });

    const recon = new ReconciliationService(
      { handleContainerDestroyed: vi.fn() } as never,
      { list: vi.fn() } as never,
      { listContainers: async () => [] },
    );
    const [report] = await recon.run('apiCalls');
    expect(report.line).toBe('apiCalls');
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: 'model_call.completed:req-quarantined',
          reason: 'quarantined_event_requeued',
        }),
        expect.objectContaining({ requestId: 'req-orphan', reason: 'orphan_api_call' }),
      ]),
    );
    const reset = await BillingOutbox.findOne({ eventId: 'model_call.completed:req-quarantined' });
    expect(reset?.failed).toBe(false);
    expect(reset?.published).toBe(false);
    expect(reset?.attempts).toBe(0);
  });

  it('containerInvoices: charge>0 但无对应账单的容器流水被报告（R6-1 发现线）', async () => {
    const { BillingInvoice } = await import('../../models/billing-invoice.js');
    const account = await accountService.getOrCreate(
      'front_user',
      new mongoose.Types.ObjectId().toString(),
      'container-invoice-user',
    );
    const reservationId = new mongoose.Types.ObjectId().toString();
    const from = Date.now() - 120_000;
    const to = Date.now() - 60_000;
    await BillingLedger.create({
      accountId: account.id,
      pool: 'cash',
      bizType: 'charge',
      deltaBalance: -100,
      deltaFrozen: 0,
      allocations: [{ pool: 'cash', amount: 100 }],
      bizId: `reservation:${reservationId}:final:${from}:${to}`,
      idempotentKey: `charge:final:${reservationId}`,
      walletApplied: true,
    });
    const recon = new ReconciliationService(
      { handleContainerDestroyed: vi.fn() } as never,
      { list: vi.fn() } as never,
      { listContainers: async () => [] },
    );
    const [report] = await recon.run('containerInvoices');
    expect(report.line).toBe('containerInvoices');
    expect(report.errorCount).toBe(1);
    expect(report.errors[0]).toMatchObject({
      reservationId,
      kind: 'final',
      reason: 'charge_without_invoice',
    });

    await BillingInvoice.create({
      _id: new mongoose.Types.ObjectId(),
      accountId: account.id,
      seq: 0,
      type: 'charge',
      category: 'container',
      amount: -100,
      balanceAfter: 0,
      idempotentKey: `invoice:container-final:${reservationId}`,
      receiptId: new mongoose.Types.ObjectId(),
      periodFrom: new Date(from),
      periodTo: new Date(to),
    });
    const [invoiceOnlyReport] = await recon.run('containerInvoices');
    // R7-1：账单已存在但收据缺失 → 仍应报告（不再只看 charge↔invoice）。
    expect(invoiceOnlyReport.errorCount).toBe(1);
    expect(invoiceOnlyReport.errors[0]).toMatchObject({ reason: 'invoice_without_receipt' });

    const { BillingReceipt } = await import('../../models/billing-receipt.js');
    const invoice = await BillingInvoice.findOne({
      idempotentKey: `invoice:container-final:${reservationId}`,
    }).lean();
    await BillingReceipt.create({
      receiptNo: 'R20261020TEST0001',
      invoiceId: invoice!._id,
      accountId: account.id,
      amount: 100,
      balanceAfter: 0,
    });
    const [coveredReport] = await recon.run('containerInvoices');
    expect(coveredReport.errorCount).toBe(0);
  });

  it('containerInvoices: 周期账单缺收据同样被报告（R7-1 覆盖 cycle 线）', async () => {
    const { BillingInvoice } = await import('../../models/billing-invoice.js');
    const account = await accountService.getOrCreate(
      'front_user',
      new mongoose.Types.ObjectId().toString(),
      'container-cycle-receipt-user',
    );
    const reservationId = new mongoose.Types.ObjectId().toString();
    const invoiceId = new mongoose.Types.ObjectId();
    await BillingInvoice.create({
      _id: invoiceId,
      accountId: account.id,
      seq: 0,
      type: 'charge',
      category: 'container',
      amount: -100,
      balanceAfter: 0,
      idempotentKey: `invoice:container-cycle:${reservationId}:0`,
      receiptId: new mongoose.Types.ObjectId(),
      periodFrom: new Date(Date.now() - 120_000),
      periodTo: new Date(Date.now() - 60_000),
    });
    const recon = new ReconciliationService(
      { handleContainerDestroyed: vi.fn() } as never,
      { list: vi.fn() } as never,
      { listContainers: async () => [] },
    );
    const [report] = await recon.run('containerInvoices');
    expect(report.errors).toContainEqual(
      expect.objectContaining({
        invoiceId: String(invoiceId),
        idempotentKey: `invoice:container-cycle:${reservationId}:0`,
        reason: 'invoice_without_receipt',
      }),
    );
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

  it('B-1: STARTING 宿主 active Key 不得被对账撤销（创建窗口无重铸）', async () => {
    const { BillingApiKey } = await import('../../models/billing-api-key.js');
    const startingHostId = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('cloudhosts').insertOne({
      _id: startingHostId,
      userId: new mongoose.Types.ObjectId(),
      controllerId: new mongoose.Types.ObjectId(),
      status: 'STARTING',
      deletedAt: null,
      createdAt: new Date(),
    });
    const key = await BillingApiKey.create({
      accountId: new mongoose.Types.ObjectId(),
      ownerType: 'front_user',
      ownerId: 'recon-starting',
      name: 'starting-key',
      keyPrefix: 'zag_sk_starting1',
      keyHash: 'h',
      scope: 'cloud_host',
      cloudHostId: startingHostId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const recon = new ReconciliationService(
      { handleContainerDestroyed: vi.fn() } as never,
      { list: vi.fn() } as never,
      { listContainers: async () => [] },
    );
    const [report] = await recon.run('cloud-host-keys');
    expect(report.checkedCount).toBe(1);
    expect(report.errorCount).toBe(0);
    // Key 在 STARTING 期铸造，本期无重铸：对账必须放行，由网关实时校验拒绝非 RUNNING 调用。
    expect((await BillingApiKey.findById(key._id).lean())?.status).toBe('active');
  });

  it('T-BK17: cloud-host-keys — 宿主非 RUNNING/已删除/过期 Key 被撤销，RUNNING 保留，账号 Key 不受影响', async () => {
    const { BillingApiKey } = await import('../../models/billing-api-key.js');
    const accountId = new mongoose.Types.ObjectId();
    const host = (status: string, deletedAt: Date | null = null) => {
      const _id = new mongoose.Types.ObjectId();
      return { _id, status, deletedAt };
    };
    const running = host('RUNNING');
    const stopped = host('STOPPED');
    const deleted = host('STOPPED', new Date());
    const missingId = new mongoose.Types.ObjectId();
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const past = new Date(Date.now() - 1000);

    for (const item of [running, stopped, deleted]) {
      await mongoose.connection.db!.collection('cloudhosts').insertOne({
        ...item,
        userId: new mongoose.Types.ObjectId(),
        controllerId: new mongoose.Types.ObjectId(),
        createdAt: new Date(),
      });
    }

    const makeKey = (cloudHostId: mongoose.Types.ObjectId | null, expiresAt: Date, scope = 'cloud_host') =>
      BillingApiKey.create({
        accountId,
        ownerType: 'front_user',
        ownerId: 'recon-user',
        name: 'k',
        keyPrefix: `zag_sk_${Math.random().toString(16).slice(2, 11)}`,
        keyHash: 'h',
        scope,
        cloudHostId,
        expiresAt,
      });

    const runningKey = await makeKey(running._id, future);
    const stoppedKey = await makeKey(stopped._id, future);
    const deletedKey = await makeKey(deleted._id, future);
    const missingKey = await makeKey(missingId, future);
    const expiredKey = await makeKey(running._id, past);
    const accountKey = await BillingApiKey.create({
      accountId,
      ownerType: 'front_user',
      ownerId: 'recon-user',
      name: 'account',
      keyPrefix: 'zag_sk_accountaa',
      keyHash: 'h',
    });

    const recon = new ReconciliationService(
      { handleContainerDestroyed: vi.fn() } as never,
      { list: vi.fn() } as never,
      { listContainers: async () => [] },
    );
    const [report] = await recon.run('cloud-host-keys');
    expect(report.line).toBe('cloud-host-keys');
    expect(report.checkedCount).toBe(5);

    const status = async (id: mongoose.Types.ObjectId) =>
      (await BillingApiKey.findById(id).lean())?.status;
    expect(await status(runningKey._id)).toBe('active');
    expect(await status(stoppedKey._id)).toBe('revoked');
    expect(await status(deletedKey._id)).toBe('revoked');
    expect(await status(missingKey._id)).toBe('revoked');
    expect(await status(expiredKey._id)).toBe('revoked');
    expect(await status(accountKey._id)).toBe('active');

    const reasons = report.errors.map((error) => error.reason);
    expect(reasons).toEqual(
      expect.arrayContaining([
        'cloud_host_not_running',
        'cloud_host_deleted',
        'cloud_host_missing',
        'expired',
      ]),
    );

    // 幂等：再跑一次不重复撤销（已撤销的不在扫描范围）
    const [second] = await recon.run('cloud-host-keys');
    expect(second.checkedCount).toBe(1);
    expect(second.errorCount).toBe(0);
  });
});
