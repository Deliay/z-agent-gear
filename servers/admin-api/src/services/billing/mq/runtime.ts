import type { Channel } from 'amqplib';
import type { BillingService } from '../billing-service.js';
import type { EventIngestService } from '../event-ingest.js';
import { MqConnection, type MqLogger } from './connection.js';
import { startMeteringConsumer, startSettlementConsumer } from './consumers.js';
import { declareBillingTopology, publishSettlementCycle } from './topology.js';

export interface BillingMqRuntimeOptions {
  url: string;
  billing: BillingService;
  ingest: EventIngestService;
  logger: MqLogger;
  /** 重连基础退避（默认 5s，指数增长 + 抖动，上限 60s）。 */
  reconnectDelayMs?: number;
}

/**
 * 计费消息消费者运行时：连接断开/通道异常后自动重建连接、重新声明拓扑并重订阅，
 * 保证 broker 重启后计费不静默停摆（PRD §4.4 积压追赶）。
 *
 * 可靠性：
 * - 失败/被替换的连接一律关闭，避免持续故障时每轮重连泄漏连接（B2）；
 * - 每个 `await` 之后复核 `stopped`，停机期间在途 connect 会拆除自己而非继续启动消费者（B3）；
 * - 连接级指数退避 + 抖动（B5）。
 */
export class BillingMqRuntime {
  private connection: MqConnection | null = null;
  private channel: Channel | null = null;
  private stopped = false;
  private reconnecting = false;
  private timer: NodeJS.Timeout | null = null;
  private connectPromise: Promise<void> | null = null;
  private attempt = 0;
  private readonly logger: MqLogger;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs = 60_000;

  constructor(private readonly options: BillingMqRuntimeOptions) {
    this.logger = options.logger;
    this.baseDelayMs = options.reconnectDelayMs ?? 5000;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async teardown(connection: MqConnection, channel: Channel | null): Promise<void> {
    try {
      await channel?.close();
    } catch {
      // ignore
    }
    await connection.close();
  }

  private async doConnect(): Promise<void> {
    if (this.stopped) return;
    const connection = new MqConnection(this.options.url, this.logger);
    let channel: Channel | null = null;
    try {
      channel = await connection.createChannel();
      if (this.stopped) {
        await this.teardown(connection, channel);
        return;
      }
      channel.on('error', (err) => {
        this.logger.warn({ err }, '[billing-mq] channel error');
      });
      channel.on('close', () => {
        // 仅在仍是「当前 channel」时触发重连，避免替换旧连接时误触发。
        if (this.channel === channel) {
          this.logger.warn('[billing-mq] channel closed, scheduling reconnect');
          this.channel = null;
          this.connection = null;
          this.scheduleReconnect();
        }
      });
      await declareBillingTopology(channel);
      if (this.stopped) {
        await this.teardown(connection, channel);
        return;
      }
      const activeChannel = channel;
      const publishSettlement = async (
        reservationId: string,
        accountId: string,
        cycleSeq: number,
      ): Promise<void> => {
        await publishSettlementCycle(activeChannel, { reservationId, accountId, cycleSeq });
      };
      await startMeteringConsumer(activeChannel, {
        billing: this.options.billing,
        ingest: this.options.ingest,
        publishSettlement,
        logger: this.logger,
      });
      if (this.stopped) {
        await this.teardown(connection, activeChannel);
        return;
      }
      await startSettlementConsumer(activeChannel, {
        billing: this.options.billing,
        publishSettlement,
        logger: this.logger,
      });
      if (this.stopped) {
        await this.teardown(connection, activeChannel);
        return;
      }

      const previousConnection = this.connection;
      const previousChannel = this.channel;
      this.connection = connection;
      this.channel = activeChannel;
      this.attempt = 0;
      // B2：替换连接前关闭旧连接/channel，避免泄漏。
      if (previousChannel && previousChannel !== activeChannel) {
        try {
          await previousChannel.close();
        } catch {
          // ignore
        }
      }
      if (previousConnection && previousConnection !== connection) {
        await previousConnection.close();
      }
      this.logger.info('[billing-mq] consumers started');
    } catch (err) {
      this.logger.warn(
        { err, attempt: this.attempt },
        '[billing-mq] connect failed, scheduling reconnect',
      );
      await this.teardown(connection, channel);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    // B5：指数退避 + 抖动，避免 broker 长时间不可用时高频重连风暴。
    const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.attempt);
    const jitter = Math.floor(Math.random() * Math.min(1000, backoff / 2));
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reconnecting = false;
      void this.connect();
    }, backoff + jitter);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.reconnecting = false;
    // 等待在途 connect 自行拆除（其每个 await 后都会复核 stopped）。
    if (this.connectPromise) {
      await this.connectPromise.catch(() => undefined);
    }
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    try {
      await channel?.close();
    } catch {
      // ignore
    }
    await connection?.close();
  }
}
