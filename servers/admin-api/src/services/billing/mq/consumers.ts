import type { Channel, ConsumeMessage } from 'amqplib';
import { config } from '../../../config/index.js';
import { BillingDeadLetter } from '../../../models/billing-dead-letter.js';
import type { BillingService } from '../billing-service.js';
import type { EventIngestService } from '../event-ingest.js';
import type { BillingEventMessage } from './publisher.js';
import type { MqLogger } from './connection.js';
import { withSpan } from '../../../observability/trace.js';
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
  logger: MqLogger;
}

function headerNumber(msg: ConsumeMessage, key: string): number {
  const value = msg.properties.headers?.[key];
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

/** R10-2：消费侧重试计数独立 header，发布侧 attempts 不再混入。 */
const CONSUMER_RETRY_HEADER = 'x-consumer-retry';

function headersWithRetry(msg: ConsumeMessage, retry: number): Record<string, unknown> {
  return { ...(msg.properties.headers ?? {}), [CONSUMER_RETRY_HEADER]: retry };
}

/**
 * R10-2：消费者视角的「重投」判定。只认消费侧计数或 broker 的 redelivered 标记；
 * 发布侧 attempts（`x-publish-attempts`）与消费重试无关，绝不触发补投门。
 */
function wasRedelivered(msg: ConsumeMessage): boolean {
  return headerNumber(msg, CONSUMER_RETRY_HEADER) > 0 || msg.fields.redelivered === true;
}

async function recordDeadLetter(
  msg: ConsumeMessage,
  queue: string,
  error: string,
  attempts: number,
  logger: MqLogger,
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
  } catch (err) {
    // B6：留档失败不得静默——DLQ 拷贝有 TTL，Mongo 留档是唯一长期副本。
    logger.warn(
      { err, routingKey: msg.fields.routingKey },
      '[billing-mq] failed to archive dead letter',
    );
  }
}

/**
 * channel 操作自保护：broker 重启/连接抖动时 amqplib 的 `ack`/`publish` 会**同步抛出**
 * （`Channel closed`）。若放任其抛出，错误会从消费回调逃逸成 unhandled rejection → 进程终止。
 * 这里统一 try/catch，仅在成功时返回 true（供调用方决定是否 ack 原消息）。
 */
function safePublish(
  channel: Channel,
  logger: MqLogger,
  exchange: string,
  routingKey: string,
  content: Buffer,
  options: {
    persistent: boolean;
    contentType: string;
    expiration?: string;
    headers: Record<string, unknown>;
    messageId?: string;
  },
): boolean {
  try {
    channel.publish(exchange, routingKey, content, options);
    return true;
  } catch (err) {
    logger.warn(
      { err, exchange, routingKey },
      '[billing-mq] publish failed (channel unavailable)',
    );
    return false;
  }
}

/** 安全 ack：channel 已关闭时 ack 抛错只告警（原消息保留在 unacked，broker 断连会重投）。 */
function safeAck(channel: Channel, msg: ConsumeMessage, logger: MqLogger): void {
  try {
    channel.ack(msg);
  } catch (err) {
    logger.warn({ err }, '[billing-mq] ack failed (channel unavailable)');
  }
}

/**
 * 手动 ack：成功才 ack；失败按指数退避重投，超次落死信（DLQ + Mongo 留档）。
 *
 * 可靠性（阻断项 2）：本函数**绝不抛出**——catch 路径内的 `publish`/`ack` 全部自保护。
 * 采用「先投递再 ack」：重投失败时不 ack，原消息保留在 unacked 由 broker 重投（at-least-once），
 * 避免 channel 抖动时把错误升级为进程崩溃。
 */
export async function consumeWithRetry(
  channel: Channel,
  msg: ConsumeMessage,
  options: {
    routingKey: string;
    retryQueue: string;
    dlq: string;
    logger: MqLogger;
    handler: () => Promise<void>;
  },
): Promise<void> {
  try {
    await options.handler();
    safeAck(channel, msg, options.logger);
  } catch (err) {
    const retry = headerNumber(msg, CONSUMER_RETRY_HEADER) + 1;
    const message = err instanceof Error ? err.message : String(err);
    if (retry > config.rabbitmqRetryMax) {
      options.logger.warn(
        { err, routingKey: options.routingKey, retry },
        '[billing-mq] consume exceeded retries → DLQ',
      );
      await recordDeadLetter(msg, options.retryQueue, message, retry, options.logger);
      const published = safePublish(channel, options.logger, BILLING_DLX, options.dlq, msg.content, {
        persistent: true,
        contentType: 'application/json',
        headers: headersWithRetry(msg, retry),
        // B8：DLQ 重投保留原始 messageId，便于按消息溯源。
        messageId: typeof msg.properties.messageId === 'string' ? msg.properties.messageId : undefined,
      });
      // 投递失败则不 ack：原消息留在 unacked，断连重投后再次进入 DLQ 路径。
      if (published) safeAck(channel, msg, options.logger);
      return;
    }
    options.logger.warn(
      { err, routingKey: options.routingKey, retry, maxRetries: config.rabbitmqRetryMax },
      '[billing-mq] consume failed, re-queued with backoff',
    );
    // per-message expiration 实现指数退避（队列本身不设 TTL）
    const published = safePublish(
      channel,
      options.logger,
      BILLING_RETRY_EXCHANGE,
      options.routingKey,
      msg.content,
      {
        persistent: true,
        contentType: 'application/json',
        expiration: String(retryBackoffMs(retry)),
        headers: headersWithRetry(msg, retry),
      },
    );
    if (published) safeAck(channel, msg, options.logger);
  }
}

export async function startMeteringConsumer(
  channel: Channel,
  deps: MeteringConsumerDeps,
): Promise<void> {
  const logger = deps.logger;
  await channel.prefetch(config.rabbitmqPrefetch);
  await channel.consume(METERING_QUEUE, (msg) => {
    if (!msg) return;
    const routingKey = msg.fields.routingKey;
    // 消费循环每批一个 span（订阅回调入口，F11）：批内不逐消息/逐步骤开 span。
    void withSpan(
      'messaging.process',
      {
        'messaging.system': 'rabbitmq',
        'messaging.destination.name': METERING_QUEUE,
        'messaging.operation.type': 'process',
        'messaging.batch.message_count': 1,
      },
      () =>
        consumeWithRetry(channel, msg, {
          routingKey,
          retryQueue: METERING_QUEUE,
          dlq: METERING_DLQ,
          logger,
          handler: async () => {
            const event = JSON.parse(msg.content.toString()) as BillingEventMessage;
            const redelivered = wasRedelivered(msg);
            const { created } = await deps.ingest.ingest({
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
              // 门控副作用（阻断项 3）：仅「本次真正建了预留/首期」才投递下一期延迟消息，
              // 避免重复投递的 container.ready 反复投 settlement 造成链路放大。
              // R7：若上次投递延迟消息失败（消费侧重投），补投以恢复结算链（缺链兜底）。
              // R10-2：只认消费侧重投/redelivered，发布侧 attempts 不再误触发。
              // R-1：乱序门控命中（该资源已 destroyed/已 legacy 计费）时绝不投递结算链。
              if (
                !result.skipped &&
                result.reservationId &&
                (result.created || redelivered)
              ) {
                await deps.publishSettlement(result.reservationId, event.accountId, result.nextCycleSeq);
              }
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
            // `created=false` 表示该事实此前已接入；记录型副作用本身由各自的幂等键门控，
            // 此处仅作可观测性提示（不因重复接入而中断必要处理，避免 at-least-once 下漏处理）。
            if (!created) {
              logger.warn({ eventId: event.eventId }, '[billing-mq] duplicate event delivered');
            }
          },
        }),
    ).catch((err) => {
      // 双保险：consumeWithRetry 已不抛出，此处兜底防止任何意外 rejection 逃逸为进程崩溃。
      logger.warn({ err }, '[billing-mq] metering consume failed');
    });
  });
}

export interface SettlementConsumerDeps {
  billing: BillingService;
  publishSettlement: (reservationId: string, accountId: string, cycleSeq: number) => Promise<void>;
  logger: MqLogger;
}

export async function startSettlementConsumer(
  channel: Channel,
  deps: SettlementConsumerDeps,
): Promise<void> {
  const logger = deps.logger;
  await channel.prefetch(config.rabbitmqPrefetch);
  await channel.consume(SETTLEMENT_QUEUE, (msg) => {
    if (!msg) return;
    // 消费循环每批一个 span（订阅回调入口，F11）：批内不逐消息/逐步骤开 span。
    void withSpan(
      'messaging.process',
      {
        'messaging.system': 'rabbitmq',
        'messaging.destination.name': SETTLEMENT_QUEUE,
        'messaging.operation.type': 'process',
        'messaging.batch.message_count': 1,
      },
      () =>
        consumeWithRetry(channel, msg, {
          routingKey: msg.fields.routingKey,
          retryQueue: SETTLEMENT_QUEUE,
          dlq: SETTLEMENT_DLQ,
          logger,
          handler: async () => {
            const message = JSON.parse(msg.content.toString()) as SettlementMessage;
            const redelivered = wasRedelivered(msg);
            const result = await deps.billing.handleSettlementCycle(
              message.reservationId,
              message.cycleSeq,
            );
            // 门控副作用（阻断项 3）：仅「本轮确实完成结算」才投递下一期。
            // 重复投递的 cycle 会被 `settleCycle` 去重门判为未结算（settled=false），不再投下一期。
            // R7：消费侧重投消息补投下一期，恢复「上一轮投递失败」造成的结算链缺链。
            // R10-2：发布侧 attempts 不再参与判定。
            if (!result.shouldDestroy && (result.settled || redelivered)) {
              await deps.publishSettlement(
                message.reservationId,
                message.accountId,
                result.nextCycleSeq,
              );
            }
          },
        }),
    ).catch((err) => {
      logger.warn({ err }, '[billing-mq] settlement consume failed');
    });
  });
}
