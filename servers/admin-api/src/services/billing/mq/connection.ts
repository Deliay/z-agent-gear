import amqp, { type Channel, type ChannelModel, type ConfirmChannel } from 'amqplib';
import type { ObservationLogger } from '../../../observability/logger.js';

/** 计费 MQ 注入面（外部装配用）：pino 原生四方法子集（调用签名见 contracts/observability.md）。 */
export type MqLogger = ObservationLogger;

/** RabbitMQ 连接（自动重连：断线后下次取 channel 时重新建立）。
 * 握手超时（默认 10s）：amqplib 仅在建连握手期间应用 socket timeout，
 * 防止代理接受 TCP 但 AMQP 握手永不完成导致 start 永久阻塞（连接建立后自动解除）。 */
export class MqConnection {
  private model: ChannelModel | null = null;
  private connecting: Promise<ChannelModel> | null = null;
  private readonly connectTimeoutMs: number;

  constructor(
    private readonly url: string,
    private readonly logger: MqLogger,
    connectTimeoutMs = 10_000,
  ) {
    this.connectTimeoutMs = connectTimeoutMs;
  }

  async getModel(): Promise<ChannelModel> {
    if (this.model) return this.model;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const model = await amqp.connect(this.url, { timeout: this.connectTimeoutMs });
      model.on('close', () => {
        this.model = null;
      });
      model.on('error', (err) => {
        this.logger.warn({ err }, '[billing-mq] connection error');
      });
      this.model = model;
      return model;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async createChannel(): Promise<Channel> {
    const model = await this.getModel();
    return model.createChannel();
  }

  async createConfirmChannel(): Promise<ConfirmChannel> {
    const model = await this.getModel();
    return model.createConfirmChannel();
  }

  async close(): Promise<void> {
    try {
      await this.model?.close();
    } catch {
      // ignore
    } finally {
      this.model = null;
    }
  }
}
