import crypto from 'crypto';
import type { Redis } from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';

const REQUEST_CHANNEL = 'mcp:forward:request';
const RESPONSE_CHANNEL = 'mcp:forward:response';

export class ForwardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ForwardError';
  }
}

interface ForwardRequest {
  serverId: string;
  sessionId: string;
  request: unknown;
}

export class McpForwarder {
  constructor(private readonly timeoutMs: number = 30_000) {}

  private subscriberPromise: Promise<Redis> | null = null;

  private getSubscriber(): Promise<Redis> {
    if (!this.subscriberPromise) {
      const sub = getRedisClient().duplicate();
      this.subscriberPromise = sub
        .subscribe(RESPONSE_CHANNEL)
        .then(() => sub)
        .catch((err: Error) => {
          this.subscriberPromise = null;
          throw new ForwardError('FORWARD_ERROR', `Failed to subscribe ${RESPONSE_CHANNEL}: ${err.message}`);
        });
    }
    return this.subscriberPromise;
  }

  async request(msg: ForwardRequest): Promise<unknown> {
    const requestId = crypto.randomUUID();
    // Await the subscription before publishing so the response can never arrive
    // before this client has joined the channel.
    const subscriber = await this.getSubscriber();

    return new Promise((resolve, reject) => {
      const onMessage = (channel: string, message: string) => {
        if (channel !== RESPONSE_CHANNEL) return;
        try {
          const data = JSON.parse(message) as {
            requestId: string;
            response?: unknown;
            error?: { code?: string; message?: string };
          };
          if (data.requestId !== requestId) return;
          clearTimeout(timeout);
          subscriber.off('message', onMessage);
          if (data.error) {
            reject(new ForwardError(data.error.code || 'FORWARD_ERROR', data.error.message || 'Forward error'));
            return;
          }
          resolve(data.response);
        } catch {}
      };

      const timeout = setTimeout(() => {
        subscriber.off('message', onMessage);
        reject(new ForwardError('FORWARD_TIMEOUT', 'Forward timeout'));
      }, this.timeoutMs);
      timeout.unref?.();

      subscriber.on('message', onMessage);
      void publish(REQUEST_CHANNEL, { requestId, ...msg } as Record<string, unknown>);
    });
  }
}

export const mcpForwarder = new McpForwarder();
