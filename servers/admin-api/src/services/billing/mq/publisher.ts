import { BillingOutbox } from '../../../models/billing-outbox.js';
import { MqConnection, type MqLogger } from './connection.js';
import {
  BILLING_EVENTS_EXCHANGE,
  declareBillingTopology,
} from './topology.js';
import type { ConfirmChannel } from 'amqplib';

export interface BillingEventMessage {
  eventId: string;
  eventType:
    | 'container.ready'
    | 'container.destroyed'
    | 'model_call.completed'
    | 'model_call.aborted';
  occurredAt: string;
  accountId: string;
  resourceId: string;
  payload: Record<string, unknown>;
}

/**
 * R10-3：区分**消息级被拒**与**传输级失败**。只有 broker 明确以 AMQP 回复码拒绝消息
 * （如 403 ACCESS_REFUSED、404 NOT_FOUND、406 PRECONDITION_FAILED）才消耗 per-message attempts；
 * 连接断开/confirm 超时等传输失败不得烧 attempts，否则短时故障就会把积压整体隔离。
 */
export function isMessageLevelRejection(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as { replyCode?: unknown; message?: unknown };
  if (typeof record.replyCode === 'number') return true;
  const message = typeof record.message === 'string' ? record.message : '';
  return /NO_ROUTE|ACCESS_REFUSED|PRECONDITION_FAILED|NOT_FOUND|RESOURCE_LOCKED/.test(message);
}

/** admin-api 侧 outbox relay：只处理 `producer='admin-api'` 的行。 */
export class AdminOutboxPublisher {
  private readonly connection: MqConnection;
  private timer: NodeJS.Timeout | null = null;
  private relaying = false;
  private readonly logger: MqLogger;
  private readonly instanceId = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  private readonly maxAttempts = 20;
  private readonly leaseMs = 30_000;
  private readonly maxBackoffMs = 30_000;
  private failureStreak = 0;
  private roundFailed = false;
  /** R11-3：判活标志，避免重复 start 双循环、stop 后在途 run 续排定时器。 */
  private started = false;

  constructor(
    private readonly url: string,
    logger: MqLogger,
    private readonly intervalMs = 2000,
  ) {
    this.connection = new MqConnection(url, logger);
    this.logger = logger;
  }

  async enqueue(event: BillingEventMessage): Promise<void> {
    try {
      await BillingOutbox.create({
        eventId: event.eventId,
        producer: 'admin-api',
        eventType: event.eventType,
        routingKey: event.eventType,
        payload: event,
        published: false,
        attempts: 0,
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  /**
   * 原子认领一批待发布行（B4）：只有认领成功者发布，避免多副本 relay 双发；
   * 崩溃遗留的租约在 `leaseMs` 后自动可被再次认领。
   */
  private async claimBatch(limit: number): Promise<
    Array<{ eventId: string; routingKey: string; payload: BillingEventMessage; attempts: number }>
  > {
    const now = new Date();
    const leaseCutoff = new Date(now.getTime() - this.leaseMs);
    const claimed: Array<{
      eventId: string;
      routingKey: string;
      payload: BillingEventMessage;
      attempts: number;
    }> = [];
    for (let i = 0; i < limit; i += 1) {
      const doc = await BillingOutbox.findOneAndUpdate(
        {
          producer: 'admin-api',
          published: false,
          failed: { $ne: true },
          $or: [{ claimedAt: null }, { claimedAt: { $lte: leaseCutoff } }],
        },
        { $set: { claimedAt: now, claimedBy: this.instanceId } },
        { returnDocument: 'after', sort: { createdAt: 1 } },
      ).lean<{
        eventId: string;
        routingKey: string;
        payload: BillingEventMessage;
        attempts?: number;
      } | null>();
      if (!doc) break;
      claimed.push({
        eventId: doc.eventId,
        routingKey: doc.routingKey,
        payload: doc.payload,
        attempts: doc.attempts ?? 0,
      });
    }
    return claimed;
  }

  private async markFailure(eventId: string, message: string, attempts: number): Promise<void> {
    const nextAttempts = attempts + 1;
    const failed = nextAttempts >= this.maxAttempts;
    await BillingOutbox.updateOne(
      { eventId },
      {
        $inc: { attempts: 1 },
        $set: {
          lastError: message.slice(0, 1000),
          claimedAt: null,
          claimedBy: null,
          ...(failed ? { failed: true } : {}),
        },
      },
    );
    if (failed) {
      this.logger.warn(
        { eventId, maxAttempts: this.maxAttempts },
        '[billing-outbox] event exceeded max attempts, quarantined',
      );
    }
  }

  private async releaseClaims(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await BillingOutbox.updateMany(
      { eventId: { $in: eventIds } },
      { $set: { claimedAt: null, claimedBy: null } },
    ).catch(() => undefined);
  }

  async relayOnce(): Promise<number> {
    if (this.relaying) return 0;
    this.relaying = true;
    this.roundFailed = false;
    let published = 0;
    let channel: ConfirmChannel | null = null;
    try {
      const docs = await this.claimBatch(50);
      if (docs.length === 0) return 0;

      channel = await this.connection.createConfirmChannel();
      await declareBillingTopology(channel);
      for (let index = 0; index < docs.length; index += 1) {
        const doc = docs[index]!;
        if (doc.attempts >= this.maxAttempts) {
          await this.markFailure(doc.eventId, 'exceeded max attempts', doc.attempts - 1);
          continue;
        }
        try {
          await new Promise<void>((resolve, reject) => {
            channel!.publish(
              BILLING_EVENTS_EXCHANGE,
              doc.routingKey,
              Buffer.from(JSON.stringify(doc.payload)),
              {
                persistent: true,
                contentType: 'application/json',
                messageId: doc.eventId,
                // R10-2：发布侧 attempts 只作为发布观测信息，不再冒充消费侧重试计数。
                headers: { 'x-event-id': doc.eventId, 'x-publish-attempts': doc.attempts },
              },
              (err) => (err ? reject(err) : resolve()),
            );
          });
          await BillingOutbox.updateOne(
            { eventId: doc.eventId },
            {
              $set: {
                published: true,
                publishedAt: new Date(),
                lastError: null,
                claimedAt: null,
                claimedBy: null,
              },
            },
          );
          published += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn({ err, eventId: doc.eventId }, '[billing-outbox] publish failed');
          this.roundFailed = true;
          if (isMessageLevelRejection(err)) {
            // 消息级被拒（毒消息）：消耗 attempts，达到上限后隔离。
            await this.markFailure(doc.eventId, message, doc.attempts);
          } else {
            // R10-3：传输级失败不消耗 per-message attempts，仅释放认领并进入 relay 退避。
            this.logger.warn(
              { eventId: doc.eventId, attempts: doc.attempts },
              '[billing-outbox] transport failure, attempts kept',
            );
          }
          // R-1：失败后停止本轮（不再 continue）。否则 broker 恢复后「后一条先发」，
          // 造成同类因果事件顺序翻转；剩余认领释放，下一轮按 createdAt 顺序重试。
          await this.releaseClaims(docs.slice(index).map((item) => item.eventId));
          break;
        }
      }
    } finally {
      try {
        await channel?.close();
      } catch {
        // ignore
      }
      this.relaying = false;
    }
    return published;
  }

  /** R10-3：失败轮次指数退避（2s→4s→8s→16s→30s），让 20 次尝试覆盖更长故障窗。 */
  private nextDelayMs(): number {
    if (this.failureStreak === 0) return this.intervalMs;
    return Math.min(
      this.intervalMs * 2 ** Math.min(this.failureStreak, 4),
      this.maxBackoffMs,
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const run = async () => {
      if (!this.started) return;
      try {
        await this.relayOnce();
      } catch (err) {
        this.roundFailed = true;
        this.logger.warn({ err }, '[billing-outbox] relay failed');
      }
      // stop() 可能在 relay 期间发生：此时不得续排定时器。
      if (!this.started) return;
      this.failureStreak = this.roundFailed ? this.failureStreak + 1 : 0;
      const delay = this.nextDelayMs();
      this.timer = setTimeout(run, delay);
      this.timer.unref?.();
    };
    void run();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // O-1：停机前排空在途 relay，避免已认领未发布的行长时间滞留。
    const deadline = Date.now() + this.leaseMs;
    while (this.relaying && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.connection.close();
  }
}
