import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../models/billing-dead-letter.js', () => ({
  BillingDeadLetter: { create: vi.fn(async () => ({})) },
}));
vi.mock('./topology.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./topology.js')>();
  return { ...actual };
});

import { BillingDeadLetter } from '../../../models/billing-dead-letter.js';
import {
  consumeWithRetry,
  startMeteringConsumer,
  startSettlementConsumer,
} from './consumers.js';
import { BILLING_DLX, BILLING_RETRY_EXCHANGE, METERING_DLQ, METERING_QUEUE } from './topology.js';

function fakeChannel() {
  const state: { handler?: (msg: unknown) => void } = {};
  return {
    prefetch: vi.fn(async () => undefined),
    consume: vi.fn(async (_queue: string, handler: (msg: unknown) => void) => {
      state.handler = handler;
    }),
    ack: vi.fn(),
    publish: vi.fn(),
    close: vi.fn(),
    invoke: (msg: unknown) => state.handler?.(msg),
  };
}

function message(payload: unknown, retry = 0, routingKey = 'container.ready') {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    fields: { routingKey },
    properties: { headers: { 'x-event-id': 'evt-1', 'x-retry-count': retry } },
  } as never;
}

const logger = { warn: vi.fn(), info: vi.fn() };

describe('计费消费者', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功处理才 ack', async () => {
    const channel = fakeChannel();
    const handler = vi.fn(async () => undefined);
    await consumeWithRetry(channel as never, message({}), {
      routingKey: 'container.ready',
      retryQueue: METERING_QUEUE,
      dlq: METERING_DLQ,
      logger,
      handler,
    });
    expect(handler).toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalled();
    expect(channel.publish).not.toHaveBeenCalled();
  });

  it('失败按指数退避重投（per-message expiration）', async () => {
    const channel = fakeChannel();
    await consumeWithRetry(channel as never, message({}, 2), {
      routingKey: 'container.ready',
      retryQueue: METERING_QUEUE,
      dlq: METERING_DLQ,
      logger,
      handler: async () => {
        throw new Error('boom');
      },
    });
    expect(channel.publish).toHaveBeenCalledWith(
      BILLING_RETRY_EXCHANGE,
      'container.ready',
      expect.any(Buffer),
      expect.objectContaining({ expiration: '20000', headers: expect.objectContaining({ 'x-retry-count': 3 }) }),
    );
    expect(channel.ack).toHaveBeenCalled();
  });

  it('超过最大重试落 DLQ 并写死信留档', async () => {
    const channel = fakeChannel();
    await consumeWithRetry(channel as never, message({ eventId: 'e1' }, 9), {
      routingKey: 'container.ready',
      retryQueue: METERING_QUEUE,
      dlq: METERING_DLQ,
      logger,
      handler: async () => {
        throw new Error('still boom');
      },
    });
    expect(BillingDeadLetter.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-1', attempts: 10, error: 'still boom' }),
    );
    expect(channel.publish).toHaveBeenCalledWith(
      BILLING_DLX,
      METERING_DLQ,
      expect.any(Buffer),
      expect.objectContaining({ persistent: true }),
    );
    expect(channel.ack).toHaveBeenCalled();
  });

  it('container.ready 消费：事件接入 + 预留 + 发布首期结算', async () => {
    const channel = fakeChannel();
    const billing = {
      handleContainerReady: vi.fn(async () => ({ reservationId: 'r1', nextCycleSeq: 0, created: true })),
      handleEvent: vi.fn(),
    };
    const ingest = { ingest: vi.fn(async () => ({ created: true })) };
    const publishSettlement = vi.fn(async () => undefined);
    await startMeteringConsumer(channel as never, {
      billing: billing as never,
      ingest: ingest as never,
      publishSettlement,
      logger,
    });
    await channel.invoke(
      message({
        eventId: 'container.ready:c1',
        eventType: 'container.ready',
        occurredAt: new Date().toISOString(),
        accountId: 'a1',
        resourceId: 'c1',
        payload: { billingStartedAt: new Date().toISOString() },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ingest.ingest).toHaveBeenCalled();
    expect(billing.handleContainerReady).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'a1', resourceId: 'c1' }),
    );
    expect(publishSettlement).toHaveBeenCalledWith('r1', 'a1', 0);
    expect(channel.ack).toHaveBeenCalled();
  });

  it('container.destroyed 消费走 handleEvent；结算消费发布下一期', async () => {
    const channel = fakeChannel();
    const billing = {
      handleEvent: vi.fn(async () => null),
      handleSettlementCycle: vi.fn(async () => ({
        settled: true,
        nextCycleSeq: 3,
        shouldDestroy: false,
      })),
    };
    const ingest = { ingest: vi.fn(async () => ({ created: true })) };
    const publishSettlement = vi.fn(async () => undefined);
    await startMeteringConsumer(channel as never, {
      billing: billing as never,
      ingest: ingest as never,
      publishSettlement,
      logger,
    });
    await channel.invoke(
      message(
        {
          eventId: 'container.destroyed:c1',
          eventType: 'container.destroyed',
          occurredAt: new Date().toISOString(),
          accountId: 'a1',
          resourceId: 'c1',
          payload: {},
        },
        0,
        'container.destroyed',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(billing.handleEvent).toHaveBeenCalled();

    const settlementChannel = fakeChannel();
    await startSettlementConsumer(settlementChannel as never, {
      billing: billing as never,
      publishSettlement,
      logger,
    });
    await settlementChannel.invoke(
      message(
        { reservationId: 'r1', accountId: 'a1', cycleSeq: 2 },
        0,
        'billing.settlement.cycle',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(billing.handleSettlementCycle).toHaveBeenCalledWith('r1', 2);
    expect(publishSettlement).toHaveBeenCalledWith('r1', 'a1', 3);
    expect(settlementChannel.ack).toHaveBeenCalled();
  });

  it('R7：结算重试消息（retry>0）即使本次未结算也补投下一期（缺链兜底）', async () => {
    const channel = fakeChannel();
    const billing = {
      handleEvent: vi.fn(async () => null),
      handleSettlementCycle: vi.fn(async () => ({
        settled: false,
        nextCycleSeq: 4,
        shouldDestroy: false,
      })),
    };
    const publishSettlement = vi.fn(async () => undefined);
    await startSettlementConsumer(channel as never, {
      billing: billing as never,
      publishSettlement,
      logger,
    });
    await channel.invoke(
      message({ reservationId: 'r1', accountId: 'a1', cycleSeq: 3 }, 1, 'billing.settlement.cycle'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publishSettlement).toHaveBeenCalledWith('r1', 'a1', 4);
  });

  it('R7：container.ready 重试消息（retry>0, created=false）补投首期结算', async () => {
    const channel = fakeChannel();
    const billing = {
      handleContainerReady: vi.fn(async () => ({ reservationId: 'r1', nextCycleSeq: 0, created: false })),
      handleEvent: vi.fn(),
    };
    const ingest = { ingest: vi.fn(async () => ({ created: false })) };
    const publishSettlement = vi.fn(async () => undefined);
    await startMeteringConsumer(channel as never, {
      billing: billing as never,
      ingest: ingest as never,
      publishSettlement,
      logger,
    });
    await channel.invoke(
      message(
        {
          eventId: 'container.ready:c1',
          eventType: 'container.ready',
          occurredAt: new Date().toISOString(),
          accountId: 'a1',
          resourceId: 'c1',
          payload: { billingStartedAt: new Date().toISOString() },
        },
        1,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publishSettlement).toHaveBeenCalledWith('r1', 'a1', 0);
  });
});
