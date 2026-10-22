import { Server as SocketIOServer, Socket } from 'socket.io';
import { getRedisClient } from '../middleware/redis.js';

interface ElicitationRequestData {
  requestId: string;
  sessionId: string;
  mode: 'form' | 'url';
  message: string;
  toolCallId?: string | null;
  requestedSchema?: unknown;
  elicitationId?: string;
  url?: string;
}

interface ElicitationResponseData {
  requestId: string;
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

interface ElicitationCompleteData {
  sessionId: string;
  elicitationId: string;
}

interface PendingRequest {
  socketId: string;
  sessionId: string;
  userId: string;
  controllerId?: string;
  timeout: NodeJS.Timeout;
}

interface ElicitationResolvedData {
  requestId?: string;
  sessionId: string;
  reason: 'unsupported_mode' | 'timeout' | 'cancelled';
  detail?: string;
}

const RESOLVED_REASONS = new Set(['unsupported_mode', 'timeout', 'cancelled']);
const DETAIL_MAX_LENGTH = 200;
const SESSION_ID_MAX_LENGTH = 200;
const MESSAGE_MAX_LENGTH = 4000;
const SCHEMA_MAX_BYTES = 64 * 1024;
const URL_MAX_LENGTH = 2048;

const ELICITATION_REQUEST_CHANNEL = 'elicitation:request';
const ELICITATION_RESPONSE_CHANNEL = 'elicitation:response';
const ELICITATION_COMPLETE_CHANNEL = 'elicitation:complete';
const ELICITATION_RESOLVED_CHANNEL = 'elicitation:resolved';
const TIMEOUT_MS = 60_000;

export class ElicitationManager {
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

    this.subscriber.subscribe(ELICITATION_RESPONSE_CHANNEL, (err) => {
      if (err) {
        console.error('Failed to subscribe to elicitation response channel:', err);
        return;
      }
    });

    this.subscriber.on('message', async (channel: string, message: string) => {
      if (channel !== ELICITATION_RESPONSE_CHANNEL) return;

      try {
        const data = JSON.parse(message) as ElicitationResponseData;
        await this.handleElicitationResponse(data);
      } catch (err) {
        console.error('Error handling elicitation response:', err);
      }
    });
  }

  async handleElicitationRequest(socket: Socket, data: ElicitationRequestData): Promise<void> {
    const { requestId, sessionId, mode, message, toolCallId, requestedSchema, elicitationId, url } = data;

    // 入参运行时校验：controller payload 不可信，非法请求不入 pending、不落 Redis。
    // 校验覆盖全部落库/下发字段（含 requestedSchema 体积、url 协议、toolCallId/elicitationId），
    // 避免任意体积 schema 直落 Mongo Mixed 或 javascript: URL 直达前端。
    const schemaBytes = requestedSchema == null
      ? 0
      : new TextEncoder().encode(JSON.stringify(requestedSchema)).length;
    const validNullableId = (value: unknown): boolean =>
      value == null || (typeof value === 'string' && value.length <= SESSION_ID_MAX_LENGTH);
    const validUrl = mode === 'url'
      ? typeof url === 'string' && url.length > 0 && url.length <= URL_MAX_LENGTH && /^https?:\/\//i.test(url)
      : url == null || (typeof url === 'string' && url.length <= URL_MAX_LENGTH);
    const validSchema = requestedSchema == null
      || (typeof requestedSchema === 'object' && !Array.isArray(requestedSchema) && schemaBytes <= SCHEMA_MAX_BYTES);
    if (
      typeof requestId !== 'string' || requestId.length === 0 || requestId.length > SESSION_ID_MAX_LENGTH
      || typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > SESSION_ID_MAX_LENGTH
      || (mode !== 'form' && mode !== 'url')
      || typeof message !== 'string' || message.length > MESSAGE_MAX_LENGTH
      || !validSchema || !validUrl || !validNullableId(toolCallId) || !validNullableId(elicitationId)
    ) {
      console.warn('[Elicitation] dropped invalid elicitation request: requestId=%j sessionId=%j mode=%j schemaBytes=%d', requestId, sessionId, mode, schemaBytes);
      return;
    }

    // 重复 requestId：先清旧 timer，避免悬挂的 60s 定时器泄漏/误发 timeout
    const existing = this.pendingRequests.get(requestId);
    if (existing) clearTimeout(existing.timeout);

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

    const redis = getRedisClient();
    await redis.publish(ELICITATION_REQUEST_CHANNEL, JSON.stringify({
      requestId,
      controllerId: socket.data.controllerId,
      sessionId,
      userId: socket.data.userId,
      mode,
      message,
      toolCallId,
      requestedSchema,
      elicitationId,
      url,
    }));
  }

  async handleElicitationResponse(data: ElicitationResponseData): Promise<void> {
    const { requestId, action, content } = data;
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      console.warn(`Elicitation request ${requestId} not found or already responded`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);

    if (this.io) {
      const socket = this.io.sockets.sockets.get(pending.socketId);
      if (socket) {
        socket.emit('acp:elicitation:response', { requestId, action, content });
      }
    }
  }

  async handleElicitationComplete(socket: Socket, data: ElicitationCompleteData): Promise<void> {
    const redis = getRedisClient();
    await redis.publish(ELICITATION_COMPLETE_CHANNEL, JSON.stringify({
      sessionId: data.sessionId,
      elicitationId: data.elicitationId,
      userId: socket.data.userId,
    }));
  }

  /**
   * 问询在到达用户之前已结束（模式不支持 / 被 Agent 取消）时透传，
   * 供 agent-api 把待办收敛为 failed/cancelled；用户已响应的情况不走该事件。
   */
  async handleElicitationResolved(socket: Socket, data: ElicitationResolvedData): Promise<void> {
    // 运行时校验：controller 侧的 payload 不可信，非法 reason/缺失 sessionId 直接丢弃并告警，
    // 避免未知枚举被下游静默归并。
    if (
      !data
      || typeof data.sessionId !== 'string'
      || data.sessionId.length === 0
      || data.sessionId.length > SESSION_ID_MAX_LENGTH
    ) {
      console.warn('[Elicitation] dropped resolved event with invalid sessionId');
      return;
    }
    if (!RESOLVED_REASONS.has(data.reason)) {
      console.warn('[Elicitation] dropped resolved event with unknown reason=%j', data.reason);
      return;
    }

    const requestId = typeof data.requestId === 'string' && data.requestId.length > 0
      ? data.requestId.slice(0, DETAIL_MAX_LENGTH)
      : undefined;
    // 显式白名单重建 payload：非字符串 detail / 未知字段一律丢弃，
    // 不能靠 {...data} 让对象 detail 绕过截断进入 Redis。
    const detail = typeof data.detail === 'string'
      ? data.detail.slice(0, DETAIL_MAX_LENGTH)
      : undefined;

    const redis = getRedisClient();
    await redis.publish(ELICITATION_RESOLVED_CHANNEL, JSON.stringify({
      requestId,
      sessionId: data.sessionId,
      reason: data.reason,
      ...(detail !== undefined ? { detail } : {}),
      controllerId: socket.data.controllerId,
      userId: socket.data.userId,
    }));
  }

  private handleTimeout(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    this.pendingRequests.delete(requestId);

    // 1) 回 Agent cancel（既有行为）
    // 2) 落 resolved(timeout)：60s 是唯一用户可见超时口径，待办据此收敛为 expired
    // 3) 仍回发 acp:elicitation:response{cancel} 给 controller（既有行为）
    void Promise.resolve()
      .then(() => getRedisClient().publish(ELICITATION_RESOLVED_CHANNEL, JSON.stringify({
        requestId,
        sessionId: pending.sessionId,
        userId: pending.userId,
        controllerId: pending.controllerId,
        reason: 'timeout',
        detail: 'controller-api timeout (60s)',
      })))
      .catch((err: unknown) => {
        console.error('Failed to publish elicitation resolved (timeout):', err);
      });

    if (this.io) {
      const socket = this.io.sockets.sockets.get(pending.socketId);
      if (socket) {
        socket.emit('acp:elicitation:response', {
          requestId,
          action: 'cancel',
        });
      }
    }
  }

  getPendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  /** controller 断线：清理该 socket 的 pending 与 timer，避免 60s 后对已失联会话发 timeout */
  clearForSocket(socketId: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.socketId !== socketId) continue;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(requestId);
    }
  }

  stop(): void {
    if (this.subscriber) {
      this.subscriber.disconnect();
      this.subscriber = null;
    }

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
    }
    this.pendingRequests.clear();
  }
}

export const elicitationManager = new ElicitationManager();
