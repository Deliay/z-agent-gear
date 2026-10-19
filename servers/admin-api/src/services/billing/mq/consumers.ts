import type { Channel, ConsumeMessage } from 'amqplib';
import { config } from '../../../config/index.js';
import { BillingDeadLetter } from '../../../models/billing-dead-letter.js';
import type { BillingService } from '../billing-service.js';
import type { EventIngestService } from '../event-ingest.js';
import type { BillingEventMessage } from './publisher.js';
import {
  BILLING_DLX,
  BILLING_RETRY_EXCHANGE,
  METERING_DLQ,
  METERING_QUEUE,
  SETTLEMENT_DLQ,
  SETTLEMENT_QUEUE,
  retryBackoffMs,
  type SettlementMessage,
} from './topology.js';

export interface MeteringConsumerDeps {
  billing: BillingService;
  ingest: EventIngestService;
  /** 发布下一期结算延迟消息。 */
  publishSettlement: (reservationId: string, accountId: string, cycleSeq: number) => Promise<void>;
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
}

function headerNumber(msg: ConsumeMessage, key: string): number {
  const value = msg.properties.headers?.[key];
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

function headersWithRetry(msg: ConsumeMessage, retry: number): Record<string, unknown> {
  return { ...(msg.properties.headers ?? {}), 'x-retry-count': retry };
}

async function recordDeadLetter(
  msg: ConsumeMessage,
  queue: string,
  error: string,
  attempts: number,
): Promise<void> {
  try {
    const payload = JSON.parse(msg.content.toString()) as Record<string, unknown>;
    await BillingDeadLetter.create({
      queue,
      routingKey: msg.fields.routingKey,
      eventId:
        (msg.properties.headers?.['x-event-id'] as string | undefined) ??
        (typeof payload.eventId === 'string' ? payload.eventId : null),
      payload,
      error: error.slice(0, 2000),
      attempts,
    });
  } catch {
    // 留档失败不影响 DLQ 投递
  }
}

/** 手动 ack：成功才 ack；失败按指数退避重试，超次落死信（DLQ + Mongo 留档）。 */
export async function consumeWithRetry(
  channel: Channel,
  msg: ConsumeMessage,
  options: {
    routingKey: string;
    retryQueue: string;
    dlq: string;
    logger: NonNullable<MeteringConsumerDeps['logger']>;
    handler: () => Promise<void>;
  },
): Promise<void> {
  try {
    await options.handler();
    channel.ack(msg);
  } catch (err) {
    const retry = headerNumber(msg, 'x-retry-count') + 1;
    const message = err instanceof Error ? err.message : String(err);
    if (retry > config.rabbitmqRetryMax) {
      options.logger.warn?.(`[billing-mq] ${options.routingKey} exceeded retries (${message}) → DLQ`);
      await recordDeadLetter(msg, options.retryQueue, message, retry);
      channel.publish(BILLING_DLX, options.dlq, msg.content, {
        persistent: true,
        contentType: 'application/json',
        headers: headersWithRetry(msg, retry),
      });
      channel.ack(msg);
      return;
    }
    options.logger.warn?.(
      `[billing-mq] ${options.routingKey} failed (retry ${retry}/${config.rabbitmqRetryMax}): ${message}`,
    );
    // per-message expiration 实现指数退避（队列本身不设 TTL）
    channel.publish(BILLING_RETRY_EXCHANGE, options.routingKey, msg.content, {
      persistent: true,
      contentType: 'application/json',
      expiration: String(retryBackoffMs(retry)),
      headers: headersWithRetry(msg, retry),
    });
    channel.ack(msg);
  }
}

export async function startMeteringConsumer(
  channel: Channel,
  deps: MeteringConsumerDeps,
): Promise<void> {
  const logger = deps.logger ?? console;
  await channel.prefetch(config.rabbitmqPrefetch);
  await channel.consume(METERING_QUEUE, (msg) => {
    if (!msg) return;
    const routingKey = msg.fields.routingKey;
    void consumeWithRetry(channel, msg, {
      routingKey,
      retryQueue: METERING_QUEUE,
      dlq: METERING_DLQ,
      logger,
      handler: async () => {
        const event = JSON.parse(msg.content.toString()) as BillingEventMessage;
        await deps.ingest.ingest({
          eventId: event.eventId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          accountId: event.accountId,
          resourceId: event.resourceId,
          payload: event.payload,
        });
        if (event.eventType === 'container.ready') {
          const startedAt = new Date(
            String(event.payload?.billingStartedAt ?? event.occurredAt),
          );
          const result = await deps.billing.handleContainerReady({
            accountId: event.accountId,
            resourceId: event.resourceId,
            occurredAt: startedAt,
          });
          await deps.publishSettlement(result.reservationId, event.accountId, result.nextCycleSeq);
          return;
        }
        await deps.billing.handleEvent({
          eventId: event.eventId,
          eventType: event.eventType,
          accountId: event.accountId,
          resourceId: event.resourceId,
          occurredAt: new Date(event.occurredAt),
          payload: event.payload,
        });
      },
    });
  });
}

export interface SettlementConsumerDeps {
  billing: BillingService;
  publishSettlement: (reservationId: string, accountId: string, cycleSeq: number) => Promise<void>;
  logger?: MeteringConsumerDeps['logger'];
}

export async function startSettlementConsumer(
  channel: Channel,
  deps: SettlementConsumerDeps,
): Promise<void> {
  const logger = deps.logger ?? console;
  await channel.prefetch(config.rabbitmqPrefetch);
  await channel.consume(SETTLEMENT_QUEUE, (msg) => {
    if (!msg) return;
    void consumeWithRetry(channel, msg, {
      routingKey: msg.fields.routingKey,
      retryQueue: SETTLEMENT_QUEUE,
      dlq: SETTLEMENT_DLQ,
      logger,
      handler: async () => {
        const message = JSON.parse(msg.content.toString()) as SettlementMessage;
        const result = await deps.billing.handleSettlementCycle(
          message.reservationId,
          message.cycleSeq,
        );
        if (!result.shouldDestroy && result.settled) {
          await deps.publishSettlement(
            message.reservationId,
            message.accountId,
            result.nextCycleSeq,
          );
        }
      },
    });
  });
}
