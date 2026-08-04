import crypto from 'crypto';
import { getRedisClient } from '../middleware/redis.js';

const REQUEST_CHANNEL = 'mcp:forward:request';
const RESPONSE_CHANNEL = 'mcp:forward:response';

interface ForwardRequest {
  serverId: string;
  sessionId: string;
  request: unknown;
}

export class McpForwarder {
  constructor(private readonly timeoutMs: number = 30_000) {}

  private subscriber: ReturnType<typeof getRedisClient> | null = null;

  private getSubscriber(): ReturnType<typeof getRedisClient> {
    if (!this.subscriber) {
      const sub = getRedisClient().duplicate();
      sub.subscribe(RESPONSE_CHANNEL).catch((err: Error) => {
        console.error(`Failed to subscribe to ${RESPONSE_CHANNEL}:`, err.message);
      });
      this.subscriber = sub;
    }
    return this.subscriber;
  }

  request(msg: ForwardRequest): Promise<unknown> {
    const requestId = crypto.randomUUID();
    const subscriber = this.getSubscriber();

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
            reject(new Error(data.error.message || 'FORWARD_ERROR'));
            return;
          }
          resolve(data.response);
        } catch {}
      };

      const timeout = setTimeout(() => {
        subscriber.off('message', onMessage);
        reject(new Error('FORWARD_TIMEOUT'));
      }, this.timeoutMs);
      timeout.unref?.();

      subscriber.on('message', onMessage);
      const redis = getRedisClient();
      redis.publish(REQUEST_CHANNEL, JSON.stringify({ requestId, ...msg }));
    });
  }
}

export const mcpForwarder = new McpForwarder();
