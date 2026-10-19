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
  claimedAt?: Date | null;
  claimedBy?: string | null;
  failed?: boolean;
}

export interface OutboxRepository {
  enqueue(event: BillingEventMessage, producer: string): Promise<void>;
  /** 原子认领一批待发布行（R2）：仅认领成功者发布，租约到期后可被再次认领。 */
  claim(
    producer: OutboxProducer,
    limit: number,
    claimant: string,
    leaseMs: number,
  ): Promise<OutboxRecord[]>;
  findUnpublished(producer: OutboxProducer, limit: number): Promise<OutboxRecord[]>;
  markPublished(eventId: string): Promise<void>;
  /** 记录一次失败；`attempts` 达到上限时置 `failed` 隔离（不再无限重投）。 */
  markFailed(eventId: string, error: string, maxAttempts: number): Promise<void>;
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
    const docs = (await BillingOutbox.find({ producer, published: false, failed: { $ne: true } })
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

  async claim(
    producer: OutboxProducer,
    limit: number,
    claimant: string,
    leaseMs: number,
  ): Promise<OutboxRecord[]> {
    const now = new Date();
    const leaseCutoff = new Date(now.getTime() - leaseMs);
    const claimed: OutboxRecord[] = [];
    for (let i = 0; i < limit; i += 1) {
      const doc = await BillingOutbox.findOneAndUpdate(
        {
          producer,
          published: false,
          failed: { $ne: true },
          $or: [{ claimedAt: null }, { claimedAt: { $lte: leaseCutoff } }],
        },
        { $set: { claimedAt: now, claimedBy: claimant } },
        { new: true, sort: { createdAt: 1 } },
      ).lean<{
        eventId: string;
        producer: OutboxProducer;
        eventType: string;
        routingKey: string;
        payload: BillingEventMessage;
        attempts?: number;
        claimedAt?: Date | null;
        claimedBy?: string | null;
        failed?: boolean;
      } | null>();
      if (!doc) break;
      claimed.push({
        eventId: doc.eventId,
        producer: doc.producer,
        eventType: doc.eventType,
        routingKey: doc.routingKey,
        payload: doc.payload as BillingEventMessage,
        attempts: doc.attempts ?? 0,
        claimedAt: doc.claimedAt ?? null,
        claimedBy: doc.claimedBy ?? null,
        failed: doc.failed === true,
      });
    }
    return claimed;
  }

  async markPublished(eventId: string): Promise<void> {
    await BillingOutbox.updateOne(
      { eventId },
      { $set: { published: true, publishedAt: new Date(), lastError: null, claimedAt: null, claimedBy: null } },
    );
  }

  async markFailed(eventId: string, error: string, maxAttempts: number): Promise<void> {
    const doc = await BillingOutbox.findOneAndUpdate(
      { eventId },
      {
        $inc: { attempts: 1 },
        $set: { lastError: error.slice(0, 1000), claimedAt: null, claimedBy: null },
      },
      { new: true },
    ).lean<{ attempts?: number } | null>();
    if (doc && (doc.attempts ?? 0) >= maxAttempts) {
      await BillingOutbox.updateOne({ eventId }, { $set: { failed: true } });
    }
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
      claimedAt: null,
      claimedBy: null,
      failed: false,
    });
  }

  async findUnpublished(producer: OutboxProducer, limit: number): Promise<OutboxRecord[]> {
    return [...this.store.values()]
      .filter((record) => record.producer === producer && record.failed !== true)
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }

  async claim(
    producer: OutboxProducer,
    limit: number,
    claimant: string,
    leaseMs: number,
  ): Promise<OutboxRecord[]> {
    const now = Date.now();
    const claimed: OutboxRecord[] = [];
    for (const record of this.store.values()) {
      if (claimed.length >= limit) break;
      if (record.producer !== producer || record.failed === true) continue;
      const claimedAt = record.claimedAt ? new Date(record.claimedAt).getTime() : null;
      if (claimedAt !== null && claimedAt > now - leaseMs) continue;
      record.claimedAt = new Date(now);
      record.claimedBy = claimant;
      claimed.push({ ...record });
    }
    return claimed;
  }

  async markPublished(eventId: string): Promise<void> {
    this.publishedIds.add(eventId);
    this.store.delete(eventId);
  }

  async markFailed(eventId: string, error: string, maxAttempts: number): Promise<void> {
    const record = this.store.get(eventId);
    if (record) {
      record.attempts += 1;
      record.claimedAt = null;
      record.claimedBy = null;
      record.payload = { ...record.payload, payload: { ...record.payload.payload, lastError: error } };
      if (record.attempts >= maxAttempts) record.failed = true;
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
        // R5：仅当仍是「当前连接」时才清空引用；替换路径先赋新引用再关闭旧连接，
        // 旧连接的 close 事件不得把刚建立的新连接/新 channel 引用一并清空。
        if (this.connection === connection) {
          this.connection = null;
          this.channel = null;
        }
      });
      connection.on('error', (err) => {
        this.logger.warn?.('[billing-outbox] rabbitmq connection error', err.message);
      });
      const channel = await connection.createConfirmChannel();
      channel.on('close', () => {
        if (this.channel === channel) this.channel = null;
      });
      // D1：channel 级 error 若不消费会被 amqplib 升级为 frameError 撕裂整条连接；此处仅告警。
      channel.on('error', (err) => {
        this.logger.warn?.('[billing-outbox] rabbitmq channel error', err.message);
      });
      await channel.assertExchange(BILLING_EXCHANGE, 'topic', { durable: true });
      await channel.assertExchange(BILLING_INTERNAL_EXCHANGE, 'direct', { durable: true });
      // D1：替换连接前关闭旧连接，避免 channel-only 关闭时泄漏。
      const previous = this.connection;
      this.connection = connection;
      this.channel = channel;
      if (previous && previous !== connection) {
        try {
          await previous.close();
        } catch {
          // ignore
        }
      }
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
  private readonly instanceId = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  private readonly maxAttempts = 20;
  private readonly leaseMs = 30_000;

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
      // R2：按行原子认领 + 租约；`attempts` 达上限的行已被隔离（failed=true）不再被认领。
      const records = await this.repository.claim(
        this.producer,
        50,
        this.instanceId,
        this.leaseMs,
      );
      for (const record of records) {
        if (record.attempts >= this.maxAttempts) {
          await this.repository.markFailed(record.eventId, 'exceeded max attempts', this.maxAttempts);
          continue;
        }
        try {
          await this.transport.publish(record.routingKey, record.payload);
          await this.repository.markPublished(record.eventId);
          published += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn?.(`[billing-outbox] publish failed for ${record.eventId}: ${message}`);
          await this.repository.markFailed(record.eventId, message, this.maxAttempts);
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
