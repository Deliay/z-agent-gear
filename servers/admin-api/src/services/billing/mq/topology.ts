import type { Channel } from 'amqplib';
import { config } from '../../../config/index.js';

export const BILLING_EVENTS_EXCHANGE = 'zag.billing.events';
export const BILLING_INTERNAL_EXCHANGE = 'zag.billing.internal';
export const BILLING_RETRY_EXCHANGE = 'zag.billing.retry';
export const BILLING_DLX = 'zag.billing.dlx';

export const METERING_QUEUE = 'billing.metering.q';
export const SETTLEMENT_QUEUE = 'billing.settlement.q';
export const METERING_RETRY_QUEUE = 'billing.metering.retry.q';
export const SETTLEMENT_RETRY_QUEUE = 'billing.settlement.retry.q';
export const METERING_DLQ = 'billing.metering.dlq';
export const SETTLEMENT_DLQ = 'billing.settlement.dlq';
export const SETTLEMENT_DELAY_QUEUE = 'billing.settlement.delay.q';

export const SETTLEMENT_ROUTING_KEY = 'billing.settlement.cycle';
export const SETTLEMENT_DELAY_ROUTING_KEY = 'billing.settlement.delay';

/** 重试指数退避：5s、10s、20s… 上限 5 分钟。 */
export function retryBackoffMs(retryCount: number): number {
  const base = 5000;
  return Math.min(base * 2 ** Math.max(0, retryCount - 1), 5 * 60_000);
}

/**
 * 声明计费拓扑（幂等）：
 * - 业务事件 topic exchange + 计量/结算队列；
 * - 重试队列（per-message expiration + DLX 回主 exchange，保留原 routing key，实现指数退避）；
 * - 死信队列（保留 7 天；死信同时落 Mongo 供费用中心查看）；
 * - 结算延迟队列（TTL + DLX 到内部 exchange，实现周期定时消息）。
 */
export async function declareBillingTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(BILLING_EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(BILLING_INTERNAL_EXCHANGE, 'direct', { durable: true });
  await channel.assertExchange(BILLING_RETRY_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(BILLING_DLX, 'direct', { durable: true });

  await channel.assertQueue(METERING_DLQ, {
    durable: true,
    arguments: { 'x-message-ttl': 7 * 24 * 60 * 60 * 1000 },
  });
  await channel.bindQueue(METERING_DLQ, BILLING_DLX, METERING_DLQ);
  await channel.assertQueue(SETTLEMENT_DLQ, {
    durable: true,
    arguments: { 'x-message-ttl': 7 * 24 * 60 * 60 * 1000 },
  });
  await channel.bindQueue(SETTLEMENT_DLQ, BILLING_DLX, SETTLEMENT_DLQ);

  await channel.assertQueue(METERING_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': BILLING_DLX,
      'x-dead-letter-routing-key': METERING_DLQ,
    },
  });
  await channel.bindQueue(METERING_QUEUE, BILLING_EVENTS_EXCHANGE, 'container.*');
  await channel.bindQueue(METERING_QUEUE, BILLING_EVENTS_EXCHANGE, 'model_call.*');

  await channel.assertQueue(SETTLEMENT_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': BILLING_DLX,
      'x-dead-letter-routing-key': SETTLEMENT_DLQ,
    },
  });
  await channel.bindQueue(SETTLEMENT_QUEUE, BILLING_INTERNAL_EXCHANGE, SETTLEMENT_ROUTING_KEY);

  // 重试队列：不设队列级 TTL（由消息 expiration 控制指数退避）；TTL 到期死信回原 exchange（保留 routing key）
  await channel.assertQueue(METERING_RETRY_QUEUE, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': BILLING_EVENTS_EXCHANGE },
  });
  await channel.bindQueue(METERING_RETRY_QUEUE, BILLING_RETRY_EXCHANGE, '#');
  await channel.assertQueue(SETTLEMENT_RETRY_QUEUE, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': BILLING_INTERNAL_EXCHANGE },
  });
  await channel.bindQueue(SETTLEMENT_RETRY_QUEUE, BILLING_RETRY_EXCHANGE, '#');

  // 结算延迟队列：TTL 到期死信回内部 exchange 的 settlement routing key
  await channel.assertQueue(SETTLEMENT_DELAY_QUEUE, {
    durable: true,
    arguments: {
      'x-message-ttl': Math.max(1000, config.billingCycleSeconds * 1000),
      'x-dead-letter-exchange': BILLING_INTERNAL_EXCHANGE,
      'x-dead-letter-routing-key': SETTLEMENT_ROUTING_KEY,
    },
  });
  await channel.bindQueue(
    SETTLEMENT_DELAY_QUEUE,
    BILLING_INTERNAL_EXCHANGE,
    SETTLEMENT_DELAY_ROUTING_KEY,
  );
}

export interface SettlementMessage {
  reservationId: string;
  accountId: string;
  cycleSeq: number;
  occurredAt?: string;
}

/** 发布延迟结算消息（TTL + DLX 定时）。 */
export async function publishSettlementCycle(
  channel: Channel,
  message: SettlementMessage,
): Promise<void> {
  channel.publish(
    BILLING_INTERNAL_EXCHANGE,
    SETTLEMENT_DELAY_ROUTING_KEY,
    Buffer.from(JSON.stringify({ ...message, occurredAt: new Date().toISOString() })),
    {
      persistent: true,
      contentType: 'application/json',
      headers: { 'x-event-id': `settlement:${message.reservationId}:${message.cycleSeq}` },
    },
  );
}
