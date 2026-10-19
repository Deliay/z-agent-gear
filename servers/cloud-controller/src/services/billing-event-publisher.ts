import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import { BillingOutbox } from '../models/billing-outbox.js';

/** 计费事件统一入口 exchange（topic，durable）。 */
export const BILLING_EXCHANGE = 'zag.billing.events';
/** 调度消息 exchange（direct，durable）。 */
export const BILLING_INTERNAL_EXCHANGE = 'zag.billing.internal';

/** 业务事件（事实层）：只描述发生了什么，不携带金额。 */
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

export interface OutboxRecord {
  eventId: string;
  producer: string;
  eventType: string;
  routingKey: string;
  payload: BillingEventMessage;
  attempts: number;
}

export interface OutboxRepository {
  enqueue(event: BillingEventMessage, producer: string): Promise<void>;
  findUnpublished(producer: OutboxProducer, limit: number): Promise<OutboxRecord[]>;
  markPublished(eventId: string): Promise<void>;
  markFailed(eventId: string, error: string): Promise<void>;
}

export type OutboxProducer = 'cloud-controller' | 'admin-api';

export interface EventTransport {
  publish(routingKey: string, message: BillingEventMessage): Promise<void>;
  close(): Promise<void>;
}

/** Mongo 实现：`billingoutbox` 共享集合（producer 区分来源）。 */
export class MongoOutboxRepository implements OutboxRepository {
  constructor(private readonly producer: OutboxProducer) {}

  async enqueue(event: BillingEventMessage): Promise<void> {
    try {
      await BillingOutbox.create({
        eventId: event.eventId,
        producer: this.producer,
        eventType: event.eventType,
        routingKey: event.eventType,
        payload: event,
        published: false,
        attempts: 0,
      });
    } catch (err) {
      // 唯一索引冲突 = 同一业务事件重复入队，幂等忽略（重复 markOnline 不应重复投递）
      if ((err as { code?: number }).code === 11000) return;
      throw err;
    }
  }

  async findUnpublished(producer: OutboxProducer, limit: number): Promise<OutboxRecord[]> {
    const docs = (await BillingOutbox.find({ producer, published: false })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean()) as unknown as Array<{
      eventId: string;
      producer: OutboxProducer;
      eventType: string;
      routingKey: string;
      payload: BillingEventMessage;
      attempts?: number;
    }>;
    return docs.map((doc) => ({
      eventId: doc.eventId,
      producer: doc.producer,
      eventType: doc.eventType,
      routingKey: doc.routingKey,
      payload: doc.payload as BillingEventMessage,
      attempts: doc.attempts ?? 0,
    }));
  }

  async markPublished(eventId: string): Promise<void> {
    await BillingOutbox.updateOne(
      { eventId },
      { $set: { published: true, publishedAt: new Date(), lastError: null } },
    );
  }

  async markFailed(eventId: string, error: string): Promise<void> {
    await BillingOutbox.updateOne(
      { eventId },
      { $inc: { attempts: 1 }, $set: { lastError: error.slice(0, 1000) } },
    );
  }
}

/** 内存实现：单测/无 broker 环境使用。 */
export class InMemoryOutboxRepository implements OutboxRepository {
  private readonly store = new Map<string, OutboxRecord>();
  private readonly publishedIds = new Set<string>();

  constructor(private readonly producer = 'cloud-controller') {}

  async enqueue(event: BillingEventMessage): Promise<void> {
    if (this.publishedIds.has(event.eventId)) return;
    if (this.store.has(event.eventId)) return;
    this.store.set(event.eventId, {
      eventId: event.eventId,
      producer: this.producer,
      eventType: event.eventType,
      routingKey: event.eventType,
      payload: event,
      attempts: 0,
    });
  }

  async findUnpublished(producer: OutboxProducer, limit: number): Promise<OutboxRecord[]> {
    return [...this.store.values()]
      .filter((record) => record.producer === producer)
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }

  async markPublished(eventId: string): Promise<void> {
    this.publishedIds.add(eventId);
    this.store.delete(eventId);
  }

  async markFailed(eventId: string, error: string): Promise<void> {
    const record = this.store.get(eventId);
    if (record) {
      record.attempts += 1;
      record.payload = { ...record.payload, payload: { ...record.payload.payload, lastError: error } };
    }
  }

  /** 测试辅助：当前未发布事件。 */
  pending(): OutboxRecord[] {
    return [...this.store.values()].map((record) => ({ ...record }));
  }
}

/** RabbitMQ 传输：publisher confirm + 自动重连（心跳 30s）。 */
export class RabbitMqTransport implements EventTransport {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private connecting: Promise<ConfirmChannel> | null = null;

  constructor(
    private readonly url: string,
    private readonly logger: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void } = console,
  ) {}

  private async ensureChannel(): Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const connection = await amqp.connect(this.url, { heartbeat: 30 });
      connection.on('close', () => {
        this.connection = null;
        this.channel = null;
      });
      connection.on('error', (err) => {
        this.logger.warn?.('[billing-outbox] rabbitmq connection error', err.message);
      });
      const channel = await connection.createConfirmChannel();
      channel.on('close', () => {
        this.channel = null;
      });
      await channel.assertExchange(BILLING_EXCHANGE, 'topic', { durable: true });
      await channel.assertExchange(BILLING_INTERNAL_EXCHANGE, 'direct', { durable: true });
      this.connection = connection;
      this.channel = channel;
      return channel;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async publish(routingKey: string, message: BillingEventMessage): Promise<void> {
    const channel = await this.ensureChannel();
    channel.publish(
      BILLING_EXCHANGE,
      routingKey,
      Buffer.from(JSON.stringify(message)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: message.eventId,
        headers: { 'x-event-id': message.eventId, 'x-retry-count': 0 },
      },
    );
    await channel.waitForConfirms();
  }

  async close(): Promise<void> {
    try {
      const channel = this.channel;
      const connection = this.connection;
      this.channel = null;
      this.connection = null;
      if (channel) await channel.close();
      if (connection) await connection.close();
    } catch {
      // 关闭期错误无需上抛
    }
  }
}

export interface BillingEventPublisherOptions {
  repository?: OutboxRepository;
  transport?: EventTransport;
  intervalMs?: number;
  producer?: OutboxProducer;
  logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}

/**
 * 事件发布器：`enqueue` 只写本地 outbox（不阻塞生命周期）；
 * `relayOnce` 读取本 producer 未发布行 → publisher confirm → 标记 published。
 */
export class BillingEventPublisher {
  private readonly repository: OutboxRepository;
  private readonly transport: EventTransport;
  private readonly intervalMs: number;
  private readonly producer: OutboxProducer;
  private readonly logger: NonNullable<BillingEventPublisherOptions['logger']>;
  private timer: NodeJS.Timeout | null = null;
  private relaying = false;

  constructor(options: BillingEventPublisherOptions = {}) {
    this.producer = options.producer ?? 'cloud-controller';
    this.repository = options.repository ?? new MongoOutboxRepository(this.producer);
    this.transport = options.transport ?? new RabbitMqTransport(
      process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
    );
    this.intervalMs = options.intervalMs ?? 2000;
    this.logger = options.logger ?? console;
  }

  async enqueue(event: BillingEventMessage): Promise<void> {
    await this.repository.enqueue(event, this.producer);
  }

  /** 单轮补投；返回本轮成功发布的条数。 */
  async relayOnce(): Promise<number> {
    if (this.relaying) return 0;
    this.relaying = true;
    let published = 0;
    try {
      const records = await this.repository.findUnpublished(this.producer, 50);
      for (const record of records) {
        try {
          await this.transport.publish(record.routingKey, record.payload);
          await this.repository.markPublished(record.eventId);
          published += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn?.(`[billing-outbox] publish failed for ${record.eventId}: ${message}`);
          await this.repository.markFailed(record.eventId, message);
        }
      }
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
    // 不阻止进程退出（测试/脚本场景）
    this.timer.unref?.();
    void this.relayOnce().catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.transport.close();
  }
}
