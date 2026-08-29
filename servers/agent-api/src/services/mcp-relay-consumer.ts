import type { Redis } from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { dispatch } from './mcp-dispatch.js';

const RELAY_REQUEST_CHANNEL = 'mcp:relay:request';

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
      console.error(`Failed to subscribe to ${RELAY_REQUEST_CHANNEL}:`, err.message);
    });

    this.subscriber.on('message', async (_channel: string, message: string) => {
      let parsed: RelayRequestMessage;
      try {
        parsed = JSON.parse(message);
      } catch {
        return;
      }
      if (!parsed.requestId || !parsed.sessionId || !parsed.token) return;

      let result: { status: number; body: unknown };
      try {
        result = await dispatch({
          sessionId: parsed.sessionId,
          serverName: parsed.serverName,
          token: parsed.token,
          body: parsed.body,
        });
      } catch (err) {
        console.error(`[MCP relay] dispatch failed: requestId=${parsed.requestId} session=${parsed.sessionId}: ${(err as Error).message}`);
        result = {
          status: 502,
          body: { jsonrpc: '2.0', id: null, error: { code: 'FORWARD_ERROR', message: (err as Error).message } },
        };
      }

      try {
        await getRedisClient().publish(
          `mcp:relay:response:${parsed.requestId}`,
          JSON.stringify({ requestId: parsed.requestId, status: result.status, body: result.body }),
        );
      } catch (err) {
        console.error(`[MCP relay] failed to publish response: requestId=${parsed.requestId}: ${(err as Error).message}`);
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