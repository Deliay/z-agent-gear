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

/** admin-api 侧 outbox relay：只处理 `producer='admin-api'` 的行。 */
export class AdminOutboxPublisher {
  private readonly connection: MqConnection;
  private timer: NodeJS.Timeout | null = null;
  private relaying = false;
  private readonly logger: MqLogger;
  private readonly instanceId = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  private readonly maxAttempts = 20;
  private readonly leaseMs = 30_000;

  constructor(
    private readonly url: string,
    logger: MqLogger = console,
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
        { new: true, sort: { createdAt: 1 } },
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
      this.logger.warn?.(
        `[billing-outbox] event ${eventId} exceeded ${this.maxAttempts} attempts, quarantined`,
      );
    }
  }

  async relayOnce(): Promise<number> {
    if (this.relaying) return 0;
    this.relaying = true;
    let published = 0;
    let channel: ConfirmChannel | null = null;
    try {
      const docs = await this.claimBatch(50);
      if (docs.length === 0) return 0;

      channel = await this.connection.createConfirmChannel();
      await declareBillingTopology(channel);
      for (const doc of docs) {
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
                headers: { 'x-event-id': doc.eventId, 'x-retry-count': 0 },
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
          this.logger.warn?.(`[billing-outbox] publish failed for ${doc.eventId}: ${message}`);
          await this.markFailure(doc.eventId, message, doc.attempts);
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

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.relayOnce().catch((err) => {
        this.logger.warn?.('[billing-outbox] relay failed', (err as Error).message);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.connection.close();
  }
}
