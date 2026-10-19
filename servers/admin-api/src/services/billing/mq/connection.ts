import amqp, { type Channel, type ChannelModel, type ConfirmChannel } from 'amqplib';

export interface MqLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/** RabbitMQ 连接（心跳 30s，自动重连：断线后下次取 channel 时重新建立）。 */
export class MqConnection {
  private model: ChannelModel | null = null;
  private connecting: Promise<ChannelModel> | null = null;

  constructor(
    private readonly url: string,
    private readonly logger: MqLogger = console,
  ) {}

  async getModel(): Promise<ChannelModel> {
    if (this.model) return this.model;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const model = await amqp.connect(this.url);
      model.on('close', () => {
        this.model = null;
      });
      model.on('error', (err) => {
        this.logger.warn?.('[billing-mq] connection error', (err as Error).message);
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
