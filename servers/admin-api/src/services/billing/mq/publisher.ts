import { BillingOutbox } from '../../../models/billing-outbox.js';
import { MqConnection, type MqLogger } from './connection.js';
import { BILLING_EVENTS_EXCHANGE, declareBillingTopology } from './topology.js';

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

  async relayOnce(): Promise<number> {
    if (this.relaying) return 0;
    this.relaying = true;
    let published = 0;
    try {
      const docs = (await BillingOutbox.find({ producer: 'admin-api', published: false })
        .sort({ createdAt: 1 })
        .limit(50)
        .lean()) as unknown as Array<{
        eventId: string;
        routingKey: string;
        payload: BillingEventMessage;
      }>;
      if (docs.length === 0) return 0;

      const channel = await this.connection.createConfirmChannel();
      await declareBillingTopology(channel);
      for (const doc of docs) {
        try {
          channel.publish(
            BILLING_EVENTS_EXCHANGE,
            doc.routingKey,
            Buffer.from(JSON.stringify(doc.payload)),
            {
              persistent: true,
              contentType: 'application/json',
              messageId: doc.eventId,
              headers: { 'x-event-id': doc.eventId, 'x-retry-count': 0 },
            },
          );
          await channel.waitForConfirms();
          await BillingOutbox.updateOne(
            { eventId: doc.eventId },
            { $set: { published: true, publishedAt: new Date(), lastError: null } },
          );
          published += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn?.(`[billing-outbox] publish failed for ${doc.eventId}: ${message}`);
          await BillingOutbox.updateOne(
            { eventId: doc.eventId },
            { $inc: { attempts: 1 }, $set: { lastError: message.slice(0, 1000) } },
          );
        }
      }
      await channel.close();
    } finally {
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
