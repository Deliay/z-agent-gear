import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BillingEvent } from '../../models/billing-event.js';
import { eventIngestService } from './event-ingest.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

const base = {
  eventId: 'container.ready:c1',
  eventType: 'container.ready',
  occurredAt: new Date('2026-10-01T00:00:00Z'),
  accountId: 'acct-1',
  resourceId: 'c1',
  payload: { billingStartedAt: '2026-10-01T00:00:00Z' },
};

describe('EventIngestService', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  it('T-B1: 重复 eventId 不产生第二条事件', async () => {
    const first = await eventIngestService.ingest(base);
    expect(first.created).toBe(true);
    const second = await eventIngestService.ingest(base);
    expect(second.created).toBe(false);
    expect(await BillingEvent.countDocuments()).toBe(1);
  });

  it('非法时间抛错；可按 eventId 回读', async () => {
    await expect(
      eventIngestService.ingest({ ...base, occurredAt: 'not-a-date' }),
    ).rejects.toThrow();
    await eventIngestService.ingest(base);
    const event = await eventIngestService.getByEventId(base.eventId);
    expect(event?.resourceId).toBe('c1');
    expect(await eventIngestService.getByEventId('missing')).toBeNull();
  });
});
