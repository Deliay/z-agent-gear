import type { Redis } from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';
import { logger as rootLogger } from '../observability/logger.js';
import { dispatch } from './mcp-dispatch.js';

const RELAY_REQUEST_CHANNEL = 'mcp:relay:request';

const logger = rootLogger.child({ component: 'mcp-relay-consumer' });

interface RelayRequestMessage {
  requestId?: string;
  sessionId?: string;
  serverName?: string;
  token?: string;
  body?: unknown;
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

      const method = (parsed.body as { method?: string })?.method ?? '?';
      logger.debug(
        { event: 'request', requestId: parsed.requestId, sessionId: parsed.sessionId, serverName: parsed.serverName ?? null, method },
        'MCP relay request',
      );
      let result: { status: number; body: unknown };
      try {
        result = await dispatch({
          sessionId: parsed.sessionId,
          serverName: parsed.serverName,
          token: parsed.token,
          body: parsed.body,
        });
      } catch (err) {
        logger.error(
          { event: 'dispatch-failed', requestId: parsed.requestId, sessionId: parsed.sessionId, err },
          'MCP relay dispatch failed',
        );
        result = {
          status: 502,
          body: { jsonrpc: '2.0', id: null, error: { code: 'FORWARD_ERROR', message: (err as Error).message } },
        };
      }
      logger.debug(
        { event: 'dispatch-result', requestId: parsed.requestId, status: result.status, body: JSON.stringify(result.body)?.slice(0, 300) },
        'MCP relay dispatch result',
      );

      try {
        await publish(`mcp:relay:response:${parsed.requestId}`, {
          requestId: parsed.requestId,
          status: result.status,
          body: result.body,
        });
      } catch (err) {
        logger.error({ event: 'publish-failed', requestId: parsed.requestId, err }, 'failed to publish MCP relay response');
      }
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