import { Server as SocketIOServer, Socket } from 'socket.io';
import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';
import { withTraceMeta } from '../middleware/trace-meta.js';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';
import { extractTraceparent, withSpan } from '../observability/trace.js';

interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

interface PermissionToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  locations?: Array<{ path: string; line?: number }>;
}

interface PermissionRequestData {
  requestId: string;
  sessionId: string;
  toolCall: PermissionToolCall;
  options: PermissionOption[];
}

interface PendingRequest {
  socketId: string;
  sessionId: string;
  userId: string;
  controllerId: string;
  timeout: NodeJS.Timeout;
}

const PERMISSION_REQUEST_CHANNEL = 'permission:request';
const PERMISSION_RESPONSE_CHANNEL = 'permission:response';
const PERMISSION_RESOLVED_CHANNEL = 'permission:resolved';
const TIMEOUT_MS = 60_000;

export class PermissionManager {
  private pendingRequests = new Map<string, PendingRequest>();
  private io: SocketIOServer | null = null;
  private subscriber: ReturnType<typeof getRedisClient> | null = null;
  private readonly logger: ObservationLogger;

  constructor(logger: ObservationLogger = rootLogger.child({ component: 'permission-manager' })) {
    this.logger = logger;
  }

  start(io: SocketIOServer): void {
    this.io = io;
    this.subscribeToResponses();
  }

  private subscribeToResponses(): void {
    const redis = getRedisClient();
    this.subscriber = redis.duplicate();

    this.subscriber.subscribe(PERMISSION_RESPONSE_CHANNEL, (err) => {
      if (err) {
        this.logger.error({ err, channel: PERMISSION_RESPONSE_CHANNEL }, 'failed to subscribe to channel');
        return;
      }
    });

    this.subscriber.on('message', async (channel: string, message: string) => {
      if (channel !== PERMISSION_RESPONSE_CHANNEL) return;

      try {
        const data = JSON.parse(message) as {
          requestId: string;
          outcome: { outcome: string; optionId?: string };
          _meta?: { traceparent?: string };
        };
        const parent = extractTraceparent(data._meta);
        await withSpan(
          `${PERMISSION_RESPONSE_CHANNEL} handle`,
          { 'messaging.system': 'redis', 'messaging.destination.name': channel, requestId: data.requestId },
          () => this.handlePermissionResponse(data),
          { parent },
        );
      } catch (err) {
        this.logger.error({ err, channel }, 'error handling permission response');
      }
    });
  }

  async handlePermissionRequest(socket: Socket, data: PermissionRequestData): Promise<void> {
    const { requestId, sessionId, toolCall, options } = data;

    const timeout = setTimeout(() => {
      this.handleTimeout(requestId);
    }, TIMEOUT_MS);

    this.pendingRequests.set(requestId, {
      socketId: socket.id,
      sessionId,
      userId: socket.data.userId,
      controllerId: socket.data.controllerId,
      timeout,
    });

    await publish(PERMISSION_REQUEST_CHANNEL, {
      requestId,
      controllerId: socket.data.controllerId,
      sessionId,
      userId: socket.data.userId,
      toolCall,
      options,
    });
  }

  async handlePermissionResponse(data: { requestId: string; outcome: { outcome: string; optionId?: string } }): Promise<void> {
    const { requestId, outcome } = data;
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      this.logger.warn({ requestId }, 'permission request not found or already responded');
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);

    if (this.io) {
      const socket = this.io.sockets.sockets.get(pending.socketId);
      if (socket) {
        socket.emit('acp:permission:response', withTraceMeta({ requestId, outcome }));
      }
    }
  }

  private handleTimeout(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    this.pendingRequests.delete(requestId);

    // 60s 是唯一用户可见超时口径：回 Agent cancelled 的同时发布 permission:resolved，
    // 供 agent-api 把会话交互卡片收敛为 EXPIRED（对齐 elicitation:resolved 语义）。
    void Promise.resolve()
      .then(() => publish(PERMISSION_RESOLVED_CHANNEL, {
        requestId,
        sessionId: pending.sessionId,
        userId: pending.userId,
        controllerId: pending.controllerId,
        reason: 'timeout',
        detail: 'controller-api timeout (60s)',
      }))
      .catch((err: unknown) => {
        this.logger.error({ err, requestId }, 'failed to publish permission resolved (timeout)');
      });

    if (this.io) {
      const socket = this.io.sockets.sockets.get(pending.socketId);
      if (socket) {
        socket.emit('acp:permission:response', withTraceMeta({
          requestId,
          outcome: { outcome: 'cancelled' },
        }));
      }
    }
  }

  /**
   * controller 断线：清理该 socket 的 pending 与 timer，并逐条发布 permission:resolved(cancelled)。
   *
   * 此时 Agent 侧 Promise 悬挂至进程退出、不可能再收到回答，语义与「已取消」一致；
   * socket 已断开故不重复回 Agent。
   */
  clearForSocket(socketId: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.socketId !== socketId) continue;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(requestId);
      void Promise.resolve()
        .then(() => publish(PERMISSION_RESOLVED_CHANNEL, {
          requestId,
          sessionId: pending.sessionId,
          userId: pending.userId,
          controllerId: pending.controllerId,
          reason: 'cancelled',
          detail: 'socket disconnected',
        }))
        .catch((err: unknown) => {
          this.logger.error({ err, requestId }, 'failed to publish permission resolved (disconnect)');
        });
    }
  }

  getPendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  stop(): void {
    if (this.subscriber) {
      this.subscriber.disconnect();
      this.subscriber = null;
    }

    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
    }
    this.pendingRequests.clear();
  }
}

export const permissionManager = new PermissionManager();
