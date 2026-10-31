import { Server as SocketIOServer, Socket } from 'socket.io';
import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';
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
  timeout: NodeJS.Timeout;
}

const PERMISSION_REQUEST_CHANNEL = 'permission:request';
const PERMISSION_RESPONSE_CHANNEL = 'permission:response';
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
        socket.emit('acp:permission:response', { requestId, outcome });
      }
    }
  }

  private handleTimeout(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    this.pendingRequests.delete(requestId);

    if (this.io) {
      const socket = this.io.sockets.sockets.get(pending.socketId);
      if (socket) {
        socket.emit('acp:permission:response', {
          requestId,
          outcome: { outcome: 'cancelled' },
        });
      }
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
