import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { BillingOutbox } from '../../../models/billing-outbox.js';
import { createTestLogger } from '../../../observability/testing.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../testing/mongo.js';

/** 静音 logger（无断言路径注入）。 */
const silentLogger = createTestLogger('billing-outbox').logger;

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
    const publisher = new AdminOutboxPublisher('amqp://x', silentLogger, 1000);
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

  it('R10-3: 传输级失败不消耗 attempts，下一轮重试成功', async () => {
    const publisher = new AdminOutboxPublisher('amqp://x', silentLogger, 1000);
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
    // 传输失败保留认领结果以外的一切，不烧 per-message attempts。
    expect(failed?.attempts).toBe(0);
    expect(failed?.claimedAt).toBeNull();

    expect(await publisher.relayOnce()).toBe(1);
    expect((await BillingOutbox.findOne({ eventId: 'model_call.completed:r2' }))?.published).toBe(
      true,
    );
  });

  it('R10-3: 消息级被拒（AMQP replyCode）才消耗 attempts 并记录 lastError', async () => {
    const publisher = new AdminOutboxPublisher('amqp://x', silentLogger, 1000);
    await publisher.enqueue({
      eventId: 'model_call.completed:r3',
      eventType: 'model_call.completed',
      occurredAt: new Date().toISOString(),
      accountId: 'a1',
      resourceId: 'r3',
      payload: {},
    });
    fakeChannel.publish.mockImplementationOnce((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: Error | null) => void;
      const err = Object.assign(new Error('ACCESS_REFUSED'), { replyCode: 403 });
      callback(err);
      return true;
    });
    expect(await publisher.relayOnce()).toBe(0);
    const rejected = await BillingOutbox.findOne({ eventId: 'model_call.completed:r3' });
    expect(rejected?.published).toBe(false);
    expect(rejected?.attempts).toBe(1);
    expect(rejected?.lastError).toContain('ACCESS_REFUSED');
  });

  it('R10-2: 发布头只携带 x-publish-attempts，不再发送 x-retry-count', async () => {
    const publisher = new AdminOutboxPublisher('amqp://x', silentLogger, 1000);
    await publisher.enqueue({
      eventId: 'model_call.completed:r4',
      eventType: 'model_call.completed',
      occurredAt: new Date().toISOString(),
      accountId: 'a1',
      resourceId: 'r4',
      payload: {},
    });
    await publisher.relayOnce();
    const call = fakeChannel.publish.mock.calls.at(-1) as unknown[];
    const options = call[3] as { headers: Record<string, unknown> };
    expect(options.headers['x-publish-attempts']).toBe(0);
    expect(options.headers['x-retry-count']).toBeUndefined();
  });

  it('start/stop 启停 relay 定时器', async () => {
    const publisher = new AdminOutboxPublisher('amqp://x', silentLogger, 60_000);
    publisher.start();
    await publisher.stop();
    expect(await publisher.relayOnce()).toBe(0);
  });
});
