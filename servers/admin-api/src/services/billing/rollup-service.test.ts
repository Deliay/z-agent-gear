import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { rollupService, bucketStartOf } from './rollup-service.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

describe('RollupService', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  it('UTC 时间桶：分钟/小时/天', () => {
    const date = new Date('2026-10-01T12:34:56.789Z');
    expect(bucketStartOf(date, 'minute').toISOString()).toBe('2026-10-01T12:34:00.000Z');
    expect(bucketStartOf(date, 'hour').toISOString()).toBe('2026-10-01T12:00:00.000Z');
    expect(bucketStartOf(date, 'day').toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('按三粒度累计消费/充值并可查询', async () => {
    const accountId = new mongoose.Types.ObjectId().toString();
    const at = new Date('2026-10-01T12:34:00.000Z');
    await rollupService.recordInvoice(accountId, { type: 'charge', amount: -300, createdAt: at });
    await rollupService.recordInvoice(accountId, { type: 'recharge', amount: 1000, createdAt: at });
    await rollupService.recordInvoice(accountId, { type: 'adjust', amount: 0, createdAt: at });

    const day = await rollupService.query(
      accountId,
      'day',
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-02T00:00:00Z'),
    );
    expect(day).toHaveLength(1);
    expect(day[0].chargeTotal).toBe(300);
    expect(day[0].rechargeTotal).toBe(1000);
    expect(day[0].chargeCount).toBe(1);

    const empty = await rollupService.query(
      accountId,
      'hour',
      new Date('2026-10-02T00:00:00Z'),
      new Date('2026-10-03T00:00:00Z'),
    );
    expect(empty).toHaveLength(0);
  });
});
