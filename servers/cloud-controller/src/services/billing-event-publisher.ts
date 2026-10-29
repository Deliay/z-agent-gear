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
  /** 释放未处理的认领（保持 createdAt 顺序重试，避免租约等待）。 */
  release?(eventIds: string[]): Promise<void>;
}

export type OutboxProducer = 'cloud-controller' | 'admin-api';

export interface EventTransport {
  publish(routingKey: string, message: BillingEventMessage, attempt?: number): Promise<void>;
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
        { returnDocument: 'after', sort: { createdAt: 1 } },
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
      { returnDocument: 'after' },
    ).lean<{ attempts?: number } | null>();
    if (doc && (doc.attempts ?? 0) >= maxAttempts) {
      await BillingOutbox.updateOne({ eventId }, { $set: { failed: true } });
    }
  }

  async release(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await BillingOutbox.updateMany(
      { eventId: { $in: eventIds } },
      { $set: { claimedAt: null, claimedBy: null } },
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

  async release(eventIds: string[]): Promise<void> {
    for (const eventId of eventIds) {
      const record = this.store.get(eventId);
      if (record) {
        record.claimedAt = null;
        record.claimedBy = null;
      }
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

  async publish(routingKey: string, message: BillingEventMessage, attempt = 0): Promise<void> {
    const channel = await this.ensureChannel();
    channel.publish(
      BILLING_EXCHANGE,
      routingKey,
      Buffer.from(JSON.stringify(message)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: message.eventId,
        // R10-2：发布侧 attempts 仅作观测（x-publish-attempts），消费侧重试使用独立 header。
        headers: { 'x-event-id': message.eventId, 'x-publish-attempts': attempt },
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

/**
 * R10-3：只有 broker 明确以 AMQP 回复码拒绝消息才视为消息级失败（消耗 attempts）；
 * 连接/confirm 超时等传输级失败不得烧 per-message attempts。
 */
export function isMessageLevelRejection(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as { replyCode?: unknown; message?: unknown };
  if (typeof record.replyCode === 'number') return true;
  const message = typeof record.message === 'string' ? record.message : '';
  return /NO_ROUTE|ACCESS_REFUSED|PRECONDITION_FAILED|NOT_FOUND|RESOURCE_LOCKED/.test(message);
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
  private readonly maxBackoffMs = 30_000;
  private failureStreak = 0;
  private roundFailed = false;
  /** R11-3：判活标志，避免重复 start 双循环、stop 后在途 run 续排定时器。 */
  private started = false;

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
    this.roundFailed = false;
    let published = 0;
    try {
      // R2：按行原子认领 + 租约；`attempts` 达上限的行已被隔离（failed=true）不再被认领。
      const records = await this.repository.claim(
        this.producer,
        50,
        this.instanceId,
        this.leaseMs,
      );
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]!;
        if (record.attempts >= this.maxAttempts) {
          await this.repository.markFailed(record.eventId, 'exceeded max attempts', this.maxAttempts);
          continue;
        }
        try {
          await this.transport.publish(record.routingKey, record.payload, record.attempts);
          await this.repository.markPublished(record.eventId);
          published += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn?.(`[billing-outbox] publish failed for ${record.eventId}: ${message}`);
          this.roundFailed = true;
          if (isMessageLevelRejection(err)) {
            await this.repository.markFailed(record.eventId, message, this.maxAttempts);
          } else {
            // R10-3：传输级失败不消耗 attempts，只释放认领并进入 relay 退避。
            this.logger.warn?.(
              `[billing-outbox] transport failure, keeping ${record.eventId} attempts=${record.attempts}`,
            );
          }
          // R-1：**不要继续发布后续行**。单条失败后 continue 会让 broker 恢复后「后一条先发」，
          // ready/destroyed 这类因果事件的顺序被翻转，消费端即出现 destroyed 先结算的重复计费。
          // 停止本轮并释放剩余认领（按 createdAt 顺序重试），牺牲吞吐换顺序性。
          await this.repository
            .release?.(records.slice(index).map((item) => item.eventId))
            .catch(() => undefined);
          break;
        }
      }
    } finally {
      this.relaying = false;
    }
    return published;
  }

  /** R10-3：失败轮次指数退避（2s→4s→8s→16s→30s）。 */
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
        this.logger.warn?.('[billing-outbox] relay failed', (err as Error).message);
      }
      // stop() 可能在 relay 期间发生：此时不得续排定时器。
      if (!this.started) return;
      this.failureStreak = this.roundFailed ? this.failureStreak + 1 : 0;
      const delay = this.nextDelayMs();
      this.timer = setTimeout(run, delay);
      // 不阻止进程退出（测试/脚本场景）
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
    // O-1：停机前排空在途 relay（最多等一个租约窗口），避免已认领未发布的 outbox 行被滞留。
    const deadline = Date.now() + this.leaseMs;
    while (this.relaying && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.transport.close();
  }
}
