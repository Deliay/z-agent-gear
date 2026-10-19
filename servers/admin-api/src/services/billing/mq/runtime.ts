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
  logger?: MqLogger;
  reconnectDelayMs?: number;
}

/**
 * 计费消息消费者运行时：连接断开/通道异常后自动重建连接、重新声明拓扑并重订阅，
 * 保证 broker 重启后计费不静默停摆（PRD §4.4 积压追赶）。
 */
export class BillingMqRuntime {
  private connection: MqConnection | null = null;
  private channel: Channel | null = null;
  private stopped = false;
  private reconnecting = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly logger: MqLogger;
  private readonly reconnectDelayMs: number;

  constructor(private readonly options: BillingMqRuntimeOptions) {
    this.logger = options.logger ?? console;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5000;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const connection = new MqConnection(this.options.url, this.logger);
      const channel = await connection.createChannel();
      channel.on('error', (err) => {
        this.logger.warn?.('[billing-mq] channel error', (err as Error).message);
      });
      channel.on('close', () => {
        this.logger.warn?.('[billing-mq] channel closed, scheduling reconnect');
        this.scheduleReconnect();
      });
      await declareBillingTopology(channel);
      const publishSettlement = async (
        reservationId: string,
        accountId: string,
        cycleSeq: number,
      ): Promise<void> => {
        await publishSettlementCycle(channel, { reservationId, accountId, cycleSeq });
      };
      await startMeteringConsumer(channel, {
        billing: this.options.billing,
        ingest: this.options.ingest,
        publishSettlement,
        logger: this.logger,
      });
      await startSettlementConsumer(channel, {
        billing: this.options.billing,
        publishSettlement,
        logger: this.logger,
      });
      this.connection = connection;
      this.channel = channel;
      this.logger.info?.('[billing-mq] consumers started');
    } catch (err) {
      this.logger.warn?.('[billing-mq] connect failed, scheduling reconnect', (err as Error).message);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reconnecting = false;
      void this.connect();
    }, this.reconnectDelayMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.reconnecting = false;
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
