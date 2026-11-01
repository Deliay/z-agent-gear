import type { Redis } from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';
import { logger as rootLogger } from '../observability/logger.js';
import { extractTraceparent, withSpan } from '../observability/trace.js';
import { dispatch } from './mcp-dispatch.js';

const RELAY_REQUEST_CHANNEL = 'mcp:relay:request';

const logger = rootLogger.child({ component: 'mcp-relay-consumer' });

interface RelayRequestMessage {
  requestId?: string;
  sessionId?: string;
  serverName?: string;
  token?: string;
  body?: unknown;
  _meta?: unknown;
}

/**
 * Consumes MCP requests bridged from controller-api over Redis and dispatches
 * them through the same auth + routing logic that previously backed the public
 * /mcp entry. Publishes the result back to `mcp:relay:response:{requestId}`.
 */
export class McpRelayConsumer {
  private subscriber: Redis | null = null;

  start(): void {
    if (this.subscriber) return;

    this.subscriber = getRedisClient().duplicate();
    this.subscriber.subscribe(RELAY_REQUEST_CHANNEL).catch((err: Error) => {
      logger.error({ err, channel: RELAY_REQUEST_CHANNEL }, 'failed to subscribe to MCP relay request channel');
    });

    this.subscriber.on('message', async (_channel: string, message: string) => {
      let parsed: RelayRequestMessage;
      try {
        parsed = JSON.parse(message);
      } catch {
        return;
      }
      if (!parsed.requestId || !parsed.sessionId || !parsed.token) return;
      const { requestId, sessionId, serverName, token } = parsed;

      const method = (parsed.body as { method?: string })?.method ?? '?';
      // 消费侧对称提取（contracts/mcp-forward-redis.md §7）：发布侧 publishJson 注入的
      // `_meta.traceparent` 在回调入口提取为 span 父链路；`_meta` 缺失/非法时容忍（回退根链路）。
      const parent = extractTraceparent(parsed._meta);
      await withSpan(
        `${RELAY_REQUEST_CHANNEL} handle`,
        {
          'messaging.destination.name': RELAY_REQUEST_CHANNEL,
          requestId,
          sessionId,
          serverName: serverName ?? '',
          method,
        },
        async () => {
          logger.debug(
            { event: 'request', requestId, sessionId, serverName: serverName ?? null, method },
            'MCP relay request',
          );
          let result: { status: number; body: unknown };
          try {
            result = await dispatch({
              sessionId,
              serverName,
              token,
              body: parsed.body,
            });
          } catch (err) {
            logger.error(
              { event: 'dispatch-failed', requestId, sessionId, err },
              'MCP relay dispatch failed',
            );
            result = {
              status: 502,
              body: { jsonrpc: '2.0', id: null, error: { code: 'FORWARD_ERROR', message: (err as Error).message } },
            };
          }
          // 响应正文不入日志：第三方 MCP 响应可含凭据，字符串正文 REDACT_PATHS 管不到（contracts/observability.md §6）
          logger.debug(
            { event: 'dispatch-result', requestId, status: result.status },
            'MCP relay dispatch result',
          );

          try {
            await publish(`mcp:relay:response:${requestId}`, {
              requestId,
              status: result.status,
              body: result.body,
            });
          } catch (err) {
            logger.error({ event: 'publish-failed', requestId, err }, 'failed to publish MCP relay response');
          }
        },
        { parent },
      );
    });
  }

  async stop(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(RELAY_REQUEST_CHANNEL);
      this.subscriber.disconnect();
      this.subscriber = null;
    }
  }
}

export const mcpRelayConsumer = new McpRelayConsumer();