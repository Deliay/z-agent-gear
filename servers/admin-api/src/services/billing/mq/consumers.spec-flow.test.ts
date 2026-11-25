import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { BillingAccount } from '../../../models/billing-account.js';
import { BillingInvoice } from '../../../models/billing-invoice.js';
import { CloudBillingCursor } from '../../../models/cloud-billing-cursor.js';
import { CloudContainer } from '../../../models/cloud-container.js';
import { createTestLogger } from '../../../observability/testing.js';
import { BillingService } from '../billing-service.js';
import { EventIngestService } from '../event-ingest.js';
import { pricingService } from '../pricing.js';
import { SpecTickService } from '../spec-tick.js';
import { startMeteringConsumer } from './consumers.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../testing/mongo.js';

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-11-24T00:00:00.000Z');
const RESOURCE_ID = '507f1f77bcf86cd7994390e1';
const HOST_ID = '507f1f77bcf86cd7994390e2';
const logger = createTestLogger('billing-mq-spec').logger;

function fakeChannel() {
  const state: { handler?: (msg: unknown) => void } = {};
  return {
    prefetch: async () => undefined,
    consume: async (_queue: string, handler: (msg: unknown) => void) => {
      state.handler = handler;
    },
    ack: () => undefined,
    publish: () => undefined,
    close: async () => undefined,
    invoke: (msg: unknown) => state.handler?.(msg),
  };
}

function readyMessage(payload: Record<string, unknown>) {
  return {
    content: Buffer.from(
      JSON.stringify({
        eventId: `container.ready:${RESOURCE_ID}`,
        eventType: 'container.ready',
        occurredAt: T0.toISOString(),
        accountId: payload.accountId,
        resourceId: RESOURCE_ID,
        payload: payload.body,
      }),
    ),
    fields: { routingKey: 'container.ready', redelivered: false },
    properties: { headers: { 'x-event-id': 'evt-1', 'x-consumer-retry': 0 } },
  } as never;
}

describe('MQ container.ready 规格分流（P0-1/P0-2 回归）', () => {
  const billing = new BillingService();

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
      name: 'zag-worker-spec-flow',
      namespace: 'zag-cloud',
      purpose: 'harness',
      image: 'worker:latest',
      hostId: HOST_ID,
      hostName: 'my-cloud',
    });
  });

  it('消费入口透传 payload.spec → 建立游标；spec-tick 按规格出账 820', async () => {
    const account = await BillingAccount.create({
      ownerType: 'tenant',
      ownerId: 'tenant-1',
      ownerName: 'tenant',
      cashBalance: 10_000_000,
    });
    const channel = fakeChannel();
    const publishSettlement = async () => undefined;
    await startMeteringConsumer(channel as never, {
      billing: billing as never,
      ingest: new EventIngestService() as never,
      publishSettlement,
      logger,
    });

    await channel.invoke(
      readyMessage({
        accountId: String(account._id),
        body: {
          billingStartedAt: T0.toISOString(),
          spec: {
            specId: 'spec-8c',
            name: '8C 16G 20G',
            cpu: 8,
            memoryGi: 16,
            ephemeralStorageGi: 20,
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const cursor = await CloudBillingCursor.findOne({ resourceId: RESOURCE_ID }).lean();
    expect(cursor).toBeTruthy();
    expect(cursor?.tenantId).toBe('tenant-1');
    expect(cursor?.specCpu).toBe(8);

    const tick = new SpecTickService({ now: () => T0.getTime() + HOUR });
    await tick.tick();
    const invoice = await BillingInvoice.findOne({ refId: HOST_ID }).lean();
    expect(invoice?.amount).toBe(-82_000);
  });

  it('legacy ready（无 spec）不建规格游标（旧路径零回归）', async () => {
    const account = await BillingAccount.create({
      ownerType: 'tenant',
      ownerId: 'tenant-1',
      ownerName: 'tenant',
      cashBalance: 10_000_000,
    });
    const channel = fakeChannel();
    await startMeteringConsumer(channel as never, {
      billing: billing as never,
      ingest: new EventIngestService() as never,
      publishSettlement: async () => undefined,
      logger,
    });
    await channel.invoke(
      readyMessage({
        accountId: String(account._id),
        body: { billingStartedAt: T0.toISOString() },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await CloudBillingCursor.countDocuments({ resourceId: RESOURCE_ID })).toBe(0);
  });

  it('对账补投：已有规格游标时不再补投 ready', async () => {
    const { ReconciliationService } = await import('../reconciliation.js');
    const { BillingOutbox } = await import('../../../models/billing-outbox.js');
    const account = await BillingAccount.create({
      ownerType: 'tenant',
      ownerId: 'tenant-1',
      ownerName: 'tenant',
      cashBalance: 10_000_000,
    });
    await CloudBillingCursor.create({
      resourceId: RESOURCE_ID,
      hostId: HOST_ID,
      accountId: new mongoose.Types.ObjectId(String(account._id)),
      specId: 'spec-8c',
      specName: '8C 16G 20G',
      specCpu: 8,
      specMemoryGi: 16,
      specEphemeralStorageGi: 20,
      billingStartedAt: T0,
      chargedMinutes: 0,
    });
    const recon = new ReconciliationService(billing as never, { findByResource: async () => null } as never, {
      logger,
      listContainers: async () => [
        {
          id: RESOURCE_ID,
          status: 'online',
          billingAccountId: String(account._id),
          billingStartedAt: T0.toISOString(),
          exitedAt: null,
          specId: 'spec-8c',
          specName: '8C 16G 20G',
          specCpu: 8,
          specMemoryGi: 16,
          specEphemeralStorageGi: 20,
        },
      ],
    });
    const [report] = await recon.run('events');
    expect(report?.errorCount).toBe(0);
    expect(await BillingOutbox.countDocuments({ eventId: `container.ready:${RESOURCE_ID}` })).toBe(0);
  });
});

describe('对账补投 ready payload 携带 spec 快照（P0-2）', () => {
  const billing = new BillingService();
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  it('已收口的规格容器 destroyed 不再误报（P2-9）', async () => {
    const { ReconciliationService } = await import('../reconciliation.js');
    const account = await BillingAccount.create({
      ownerType: 'tenant',
      ownerId: 'tenant-1',
      ownerName: 'tenant',
      cashBalance: 10_000_000,
    });
    const resourceId = '507f1f77bcf86cd7994390e4';
    await CloudBillingCursor.create({
      resourceId,
      hostId: HOST_ID,
      accountId: new mongoose.Types.ObjectId(String(account._id)),
      specId: 'spec-8c',
      specName: '8C 16G 20G',
      specCpu: 8,
      specMemoryGi: 16,
      specEphemeralStorageGi: 20,
      billingStartedAt: T0,
      chargedMinutes: 60,
      destroyedAt: new Date(T0.getTime() + HOUR),
      closedAt: new Date(T0.getTime() + HOUR),
    });
    const recon = new ReconciliationService(
      billing as never,
      { findByResource: async () => null } as never,
      {
        logger,
        listContainers: async () => [
          {
            id: resourceId,
            status: 'exited',
            billingAccountId: String(account._id),
            billingStartedAt: T0.toISOString(),
            exitedAt: new Date(T0.getTime() + HOUR).toISOString(),
            specId: 'spec-8c',
            specName: '8C 16G 20G',
            specCpu: 8,
            specMemoryGi: 16,
            specEphemeralStorageGi: 20,
          },
        ],
      },
    );
    const [report] = await recon.run('events');
    expect(report?.errorCount).toBe(0);
  });

  it('无游标/无预留时补投 ready，payload.spec 来自容器快照', async () => {
    const { ReconciliationService } = await import('../reconciliation.js');
    const { BillingOutbox } = await import('../../../models/billing-outbox.js');
    const account = await BillingAccount.create({
      ownerType: 'tenant',
      ownerId: 'tenant-1',
      ownerName: 'tenant',
      cashBalance: 10_000_000,
    });
    const resourceId = '507f1f77bcf86cd7994390e3';
    const recon = new ReconciliationService(billing as never, { findByResource: async () => null } as never, {
      logger,
      listContainers: async () => [
        {
          id: resourceId,
          status: 'online',
          billingAccountId: String(account._id),
          billingStartedAt: T0.toISOString(),
          exitedAt: null,
          specId: 'spec-8c',
          specName: '8C 16G 20G',
          specCpu: 8,
          specMemoryGi: 16,
          specEphemeralStorageGi: 20,
        },
      ],
    });
    const [report] = await recon.run('events');
    expect(report?.errorCount).toBe(1);
    const outbox = await BillingOutbox.findOne({ eventId: `container.ready:${resourceId}` }).lean<{
      payload?: Record<string, unknown>;
    } | null>();
    expect(outbox?.payload).toMatchObject({
      eventType: 'container.ready',
      payload: {
        spec: { specId: 'spec-8c', cpu: 8, memoryGi: 16, ephemeralStorageGi: 20 },
      },
    });
  });
});
