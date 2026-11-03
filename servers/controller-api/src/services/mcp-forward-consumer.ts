import type { Redis } from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';
import { extractTraceparent, withSpan } from '../observability/trace.js';
import type { McpProxyRegistry } from './mcp-proxy-registry.js';

const FORWARD_REQUEST_CHANNEL = 'mcp:forward:request';
const FORWARD_RESPONSE_CHANNEL = 'mcp:forward:response';

export class McpForwardConsumer {
  private subscriber: Redis | null = null;
  private readonly logger: ObservationLogger;

  constructor(
    private registry: McpProxyRegistry,
    private redis: Redis = getRedisClient(),
    logger: ObservationLogger = rootLogger.child({ component: 'mcp-forward-consumer' }),
  ) {
    this.logger = logger;
  }

  start(): void {
    this.subscriber = this.redis.duplicate();
    this.subscriber.subscribe(FORWARD_REQUEST_CHANNEL).catch((err: Error) => {
      this.logger.error({ err, channel: FORWARD_REQUEST_CHANNEL }, 'failed to subscribe to channel');
    });

    this.subscriber.on('message', async (_channel: string, message: string) => {
      let payload: {
        requestId?: string;
        serverId?: string;
        sessionId?: string;
        request?: unknown;
        _meta?: { traceparent?: string };
      };
      try {
        payload = JSON.parse(message);
      } catch {
        return;
      }

      const { requestId, serverId, sessionId, request } = payload;
      if (!requestId || !serverId || !request) return;

      // Only the replica holding an active proxy connection handles the request
      if (!this.registry.hasActiveProxy(serverId)) return;

      // 订阅回调入口一个 span（`mcp:forward:*`，contracts/mcp-forward-redis.md §7）；无 `_meta` 容错。
      const parent = extractTraceparent(payload._meta);
      await withSpan(
        `${FORWARD_REQUEST_CHANNEL} handle`,
        {
          'messaging.system': 'redis',
          'messaging.destination.name': FORWARD_REQUEST_CHANNEL,
          requestId,
          serverId,
          sessionId,
        },
        async () => {
          try {
            const response = await this.registry.forwardRequest(`proxy_${serverId}`, request);
            await publish(
              FORWARD_RESPONSE_CHANNEL,
              { requestId, response },
              this.redis,
            );
          } catch (e) {
            await publish(
              FORWARD_RESPONSE_CHANNEL,
              {
                requestId,
                error: { code: 'FORWARD_ERROR', message: (e as Error).message },
              },
              this.redis,
            );
          }
        },
        { parent },
      );
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

