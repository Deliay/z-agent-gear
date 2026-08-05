import type { Redis } from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { mcpEndpointService } from './mcp-endpoint.js';

const SESSION_STATUS_CHANNEL = 'session:status';
const TERMINAL_STATUSES = new Set(['ended', 'removed']);

/**
 * Revokes the session MCP endpoint whenever a session reaches a terminal
 * status, regardless of which service initiated the transition.
 *
 * User-initiated closes go through SessionService (which revokes directly),
 * but controller-api can also end a session on its own (agent exit, controller
 * failure, acp:stop cleanup) by writing Mongo directly and publishing
 * `session:status`. This subscriber is the backstop for those paths so that
 * "session closed => token invalidated" always holds.
 */
export class McpEndpointRevokeSubscriber {
  private subscriber: Redis | null = null;

  constructor(private readonly endpointService: typeof mcpEndpointService = mcpEndpointService) {}

  start(): void {
    if (this.subscriber) return;

    this.subscriber = getRedisClient().duplicate();
    this.subscriber.subscribe(SESSION_STATUS_CHANNEL).catch((err: Error) => {
      console.error(`Failed to subscribe to ${SESSION_STATUS_CHANNEL}:`, err.message);
    });

    this.subscriber.on('message', async (_channel: string, message: string) => {
      let parsed: { sessionId?: string; status?: string };
      try {
        parsed = JSON.parse(message);
      } catch {
        return;
      }
      if (!parsed.sessionId || !parsed.status || !TERMINAL_STATUSES.has(parsed.status)) return;

      try {
        await this.endpointService.revokeEndpoint(parsed.sessionId);
      } catch (err) {
        console.error(`Failed to revoke MCP endpoint for session ${parsed.sessionId}:`, (err as Error).message);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(SESSION_STATUS_CHANNEL);
      this.subscriber.disconnect();
      this.subscriber = null;
    }
  }
}

export const mcpEndpointRevokeSubscriber = new McpEndpointRevokeSubscriber();
