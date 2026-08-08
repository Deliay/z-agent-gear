import { Server as SocketIOServer, Socket } from 'socket.io';
import { getRedisClient } from '../middleware/redis.js';

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

  start(io: SocketIOServer): void {
    this.io = io;
    this.subscribeToResponses();
  }

  private subscribeToResponses(): void {
    const redis = getRedisClient();
    this.subscriber = redis.duplicate();

    this.subscriber.subscribe(PERMISSION_RESPONSE_CHANNEL, (err) => {
      if (err) {
        console.error('Failed to subscribe to permission response channel:', err);
        return;
      }
    });

    this.subscriber.on('message', async (channel: string, message: string) => {
      if (channel !== PERMISSION_RESPONSE_CHANNEL) return;

      try {
        const data = JSON.parse(message) as { requestId: string; outcome: { outcome: string; optionId?: string } };
        await this.handlePermissionResponse(data);
      } catch (err) {
        console.error('Error handling permission response:', err);
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

    const redis = getRedisClient();
    await redis.publish(PERMISSION_REQUEST_CHANNEL, JSON.stringify({
      requestId,
      controllerId: socket.data.controllerId,
      sessionId,
      userId: socket.data.userId,
      toolCall,
      options,
    }));
  }

  async handlePermissionResponse(data: { requestId: string; outcome: { outcome: string; optionId?: string } }): Promise<void> {
    const { requestId, outcome } = data;
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      console.warn(`Permission request ${requestId} not found or already responded`);
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
