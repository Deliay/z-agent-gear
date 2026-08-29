import type { Redis } from 'ioredis';
import type { Socket } from 'socket.io';
import { getRedisClient } from '../middleware/redis.js';
import { acpSessionManager } from './acp-session-manager.js';

const RELAY_REQUEST_CHANNEL = 'mcp:relay:request';
const RESPONSE_CHANNEL_PREFIX = 'mcp:relay:response:';
const REQUEST_TIMEOUT_MS = 60_000;

interface McpRequestPayload {
  requestId: string;
  sessionId: string;
  serverName: string;
  token: string;
  body: unknown;
}

interface PendingRequest {
  socket: Socket;
  requestId: string;
  subscriber: Redis;
  timeout: ReturnType<typeof setTimeout>;
}

export class McpRelayService {
  private pending = new Map<string, PendingRequest>();

  handleMcpRequest(socket: Socket, payload: McpRequestPayload): void {
    const { requestId, sessionId, serverName, token, body } = payload;
    const controllerId = socket.data.controllerId as string | undefined;

    if (!controllerId || !acpSessionManager.sessionBelongsToController(sessionId, controllerId)) {
      socket.emit('mcp:response', { requestId, status: 404, body: {} });
      return;
    }

    const redis = getRedisClient();
    const subscriber = redis.duplicate();
    const responseChannel = `${RESPONSE_CHANNEL_PREFIX}${requestId}`;

    const settle = (status: number): void => {
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      subscriber.off('message', onMessage);
      subscriber.disconnect();
      pending.socket.emit('mcp:response', { requestId, status, body: {} });
    };

    const onMessage = (channel: string, message: string): void => {
      if (channel !== responseChannel) return;
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      subscriber.off('message', onMessage);
      subscriber.disconnect();
      try {
        const parsed = JSON.parse(message) as { requestId?: string; status?: number; body?: unknown };
        pending.socket.emit('mcp:response', {
          requestId: parsed.requestId ?? requestId,
          status: parsed.status ?? 200,
          body: parsed.body ?? {},
        });
      } catch {
        pending.socket.emit('mcp:response', { requestId, status: 502, body: {} });
      }
    };

    subscriber.on('message', onMessage);
    subscriber.subscribe(responseChannel).catch((err: Error) => {
      console.error(`Failed to subscribe to ${responseChannel}:`, err.message);
    });

    const timeout = setTimeout(() => settle(504), REQUEST_TIMEOUT_MS);
    this.pending.set(requestId, { socket, requestId, subscriber, timeout });

    redis.publish(
      RELAY_REQUEST_CHANNEL,
      JSON.stringify({ requestId, sessionId, serverName, token, body }),
    ).catch((err: Error) => {
      console.error('Failed to publish mcp:relay:request:', err.message);
    });
  }

  handleSocketDisconnect(socketId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.socket.id === socketId) {
        this.pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.subscriber.disconnect();
        pending.socket.emit('mcp:response', { requestId, status: 503, body: {} });
      }
    }
  }
}

export const mcpRelayService = new McpRelayService();