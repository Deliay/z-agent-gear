import { describe, it, expect, vi } from 'vitest';
import {
  declareBillingTopology,
  publishSettlementCycle,
  retryBackoffMs,
  BILLING_EVENTS_EXCHANGE,
  BILLING_INTERNAL_EXCHANGE,
  METERING_QUEUE,
  METERING_RETRY_QUEUE,
  METERING_DLQ,
  SETTLEMENT_DELAY_QUEUE,
  SETTLEMENT_DELAY_ROUTING_KEY,
} from './topology.js';

function fakeChannel() {
  return {
    assertExchange: vi.fn(async () => ({})),
    assertQueue: vi.fn(async () => ({})),
    bindQueue: vi.fn(async () => ({})),
    publish: vi.fn(),
  };
}

describe('计费 MQ 拓扑', () => {
  it('声明 exchange/队列/重试/DLQ/延迟队列（幂等口径）', async () => {
    const channel = fakeChannel();
    await declareBillingTopology(channel as never);
    expect(channel.assertExchange).toHaveBeenCalledWith(BILLING_EVENTS_EXCHANGE, 'topic', {
      durable: true,
    });
    expect(channel.assertExchange).toHaveBeenCalledWith(BILLING_INTERNAL_EXCHANGE, 'direct', {
      durable: true,
    });
    expect(channel.assertQueue).toHaveBeenCalledWith(METERING_QUEUE, expect.any(Object));
    expect(channel.assertQueue).toHaveBeenCalledWith(
      METERING_RETRY_QUEUE,
      expect.objectContaining({ durable: true }),
    );
    // 重试队列不使用队列级 TTL（改由 per-message expiration 指数退避）
    const retryArgs = (channel.assertQueue as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === METERING_RETRY_QUEUE,
    )?.[1] as { arguments?: Record<string, unknown> };
    expect(retryArgs.arguments?.['x-message-ttl']).toBeUndefined();
    // DLQ 保留 7 天
    const dlqArgs = (channel.assertQueue as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === METERING_DLQ,
    )?.[1] as { arguments?: Record<string, unknown> };
    expect(dlqArgs.arguments?.['x-message-ttl']).toBe(7 * 24 * 60 * 60 * 1000);
    expect(channel.assertQueue).toHaveBeenCalledWith(
      SETTLEMENT_DELAY_QUEUE,
      expect.objectContaining({ durable: true }),
    );
  });

  it('延迟结算消息携带 accountId，发布到内部 exchange', async () => {
    const channel = fakeChannel();
    await publishSettlementCycle(channel as never, {
      reservationId: 'r1',
      accountId: 'a1',
      cycleSeq: 2,
    });
    expect(channel.publish).toHaveBeenCalledWith(
      BILLING_INTERNAL_EXCHANGE,
      SETTLEMENT_DELAY_ROUTING_KEY,
      expect.any(Buffer),
      expect.objectContaining({ persistent: true }),
    );
    const body = JSON.parse(
      (channel.publish as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2].toString(),
    );
    expect(body).toMatchObject({ reservationId: 'r1', accountId: 'a1', cycleSeq: 2 });
  });

  it('指数退避上限 5 分钟', () => {
    expect(retryBackoffMs(1)).toBe(5000);
    expect(retryBackoffMs(2)).toBe(10_000);
    expect(retryBackoffMs(3)).toBe(20_000);
    expect(retryBackoffMs(20)).toBe(5 * 60_000);
  });
});
