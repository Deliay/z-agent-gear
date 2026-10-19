import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { BillingOutbox } from '../../../models/billing-outbox.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../testing/mongo.js';

const { fakeChannel } = vi.hoisted(() => ({
  fakeChannel: {
    publish: vi.fn(),
    waitForConfirms: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  },
}));

vi.mock('./connection.js', () => ({
  MqConnection: class {
    createConfirmChannel = vi.fn(async () => fakeChannel);
    close = vi.fn(async () => undefined);
  },
}));
vi.mock('./topology.js', () => ({
  BILLING_EVENTS_EXCHANGE: 'zag.billing.events',
  declareBillingTopology: vi.fn(async () => undefined),
}));

import { AdminOutboxPublisher } from './publisher.js';

describe('AdminOutboxPublisher', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
    vi.clearAllMocks();
    fakeChannel.publish.mockReset();
    // 默认：publish 立即以成功回调确认（publisher 使用 per-message confirm 回调）。
    fakeChannel.publish.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') (callback as (err: Error | null) => void)(null);
      return true;
    });
    fakeChannel.waitForConfirms.mockReset();
    fakeChannel.waitForConfirms.mockResolvedValue(undefined);
  });

  it('outbox → confirm → 标记 published；重复入队幂等', async () => {
    const publisher = new AdminOutboxPublisher('amqp://x', console, 1000);
    const event = {
      eventId: 'model_call.completed:r1',
      eventType: 'model_call.completed' as const,
      occurredAt: new Date().toISOString(),
      accountId: 'a1',
      resourceId: 'r1',
      payload: { modelId: 'm1' },
    };
    await publisher.enqueue(event);
    await publisher.enqueue(event);
    expect(await BillingOutbox.countDocuments()).toBe(1);

    expect(await publisher.relayOnce()).toBe(1);
    expect(fakeChannel.publish).toHaveBeenCalledWith(
      'zag.billing.events',
      'model_call.completed',
      expect.any(Buffer),
      expect.objectContaining({ messageId: event.eventId }),
      expect.any(Function),
    );
    const stored = await BillingOutbox.findOne({ eventId: event.eventId });
    expect(stored?.published).toBe(true);
    expect(stored?.publishedAt).toBeInstanceOf(Date);

    // 已发布后不会再次投递
    expect(await publisher.relayOnce()).toBe(0);
  });

  it('发布失败保留未发布并记录 attempts/lastError，下一轮重试成功', async () => {
    const publisher = new AdminOutboxPublisher('amqp://x', console, 1000);
    await publisher.enqueue({
      eventId: 'model_call.completed:r2',
      eventType: 'model_call.completed',
      occurredAt: new Date().toISOString(),
      accountId: 'a1',
      resourceId: 'r2',
      payload: {},
    });
    fakeChannel.publish.mockImplementationOnce(() => {
      throw new Error('broker down');
    });
    expect(await publisher.relayOnce()).toBe(0);
    const failed = await BillingOutbox.findOne({ eventId: 'model_call.completed:r2' });
    expect(failed?.published).toBe(false);
    expect(failed?.attempts).toBe(1);
    expect(failed?.lastError).toContain('broker down');

    expect(await publisher.relayOnce()).toBe(1);
    expect((await BillingOutbox.findOne({ eventId: 'model_call.completed:r2' }))?.published).toBe(
      true,
    );
  });

  it('start/stop 启停 relay 定时器', async () => {
    const publisher = new AdminOutboxPublisher('amqp://x', console, 60_000);
    publisher.start();
    await publisher.stop();
    expect(await publisher.relayOnce()).toBe(0);
  });
});
