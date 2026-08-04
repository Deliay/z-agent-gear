import type { Redis } from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import type { McpProxyRegistry } from './mcp-proxy-registry.js';

const FORWARD_REQUEST_CHANNEL = 'mcp:forward:request';
const FORWARD_RESPONSE_CHANNEL = 'mcp:forward:response';

export class McpForwardConsumer {
  private subscriber: Redis | null = null;

  constructor(
    private registry: McpProxyRegistry,
    private redis: Redis = getRedisClient(),
  ) {}

  start(): void {
    this.subscriber = this.redis.duplicate();
    this.subscriber.subscribe(FORWARD_REQUEST_CHANNEL).catch((err: Error) => {
      console.error(`Failed to subscribe to ${FORWARD_REQUEST_CHANNEL}:`, err.message);
    });

    this.subscriber.on('message', async (_channel: string, message: string) => {
      let payload: { requestId?: string; serverId?: string; sessionId?: string; request?: unknown };
      try {
        payload = JSON.parse(message);
      } catch {
        return;
      }

      const { requestId, serverId, sessionId, request } = payload;
      if (!requestId || !serverId || !request) return;

      // Only the replica holding an active proxy connection handles the request
      if (!this.registry.hasActiveProxy(serverId)) return;

      try {
        const response = await this.registry.forwardRequest(`proxy_${serverId}`, request);
        await this.redis.publish(
          FORWARD_RESPONSE_CHANNEL,
          JSON.stringify({ requestId, response }),
        );
      } catch (e) {
        await this.redis.publish(
          FORWARD_RESPONSE_CHANNEL,
          JSON.stringify({
            requestId,
            error: { code: 'FORWARD_ERROR', message: (e as Error).message },
          }),
        );
      }
    });
  }

  async stop(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(FORWARD_REQUEST_CHANNEL);
      this.subscriber.disconnect();
      this.subscriber = null;
    }
  }
}

