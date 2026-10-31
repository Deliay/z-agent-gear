import type { Redis } from 'ioredis';
import type { Socket } from 'socket.io';
import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';
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
  private readonly logger: ObservationLogger;

  constructor(logger: ObservationLogger = rootLogger.child({ component: 'mcp-relay' })) {
    this.logger = logger;
  }

  async handleMcpRequest(socket: Socket, payload: McpRequestPayload): Promise<void> {
    const { requestId, sessionId, serverName, token, body } = payload;
    const controllerId = socket.data.controllerId as string | undefined;

    this.logger.info(
      {
        requestId,
        sessionId,
        serverName,
        method: (body as { method?: string })?.method ?? null,
        controllerId: controllerId ?? null,
      },
      'mcp:request received',
    );
    if (!controllerId || !acpSessionManager.sessionBelongsToController(sessionId, controllerId)) {
      this.logger.warn({ requestId, sessionId, controllerId: controllerId ?? null }, 'mcp:request -> 404 (session not owned by controller)');
      socket.emit('mcp:response', { requestId, status: 404, body: {} });
      return;
    }

    const redis = getRedisClient();
    const subscriber = redis.duplicate();
    const responseChannel = `${RESPONSE_CHANNEL_PREFIX}${requestId}`;

    const settle = (status: number): void => {
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.logger.info({ requestId, status }, 'mcp:request settle');
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
        this.logger.info({ requestId, status: parsed.status ?? 200 }, 'mcp:request response from agent-api');
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
    const timeout = setTimeout(() => settle(504), REQUEST_TIMEOUT_MS);
    this.pending.set(requestId, { socket, requestId, subscriber, timeout });

    // 先 await 订阅完成再 publish，避免「响应先于订阅」竞态导致响应丢失而 60s 超时
    try {
      await subscriber.subscribe(responseChannel);
    } catch (err) {
      this.logger.error({ err, channel: responseChannel, requestId }, 'failed to subscribe to response channel');
      settle(504);
      return;
    }

    void Promise.resolve(
      publish(RELAY_REQUEST_CHANNEL, { requestId, sessionId, serverName, token, body }),
    ).catch((err: Error) => {
      this.logger.error({ err, requestId }, 'failed to publish mcp:relay:request');
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