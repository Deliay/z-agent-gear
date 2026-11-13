import Redis from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { logger as rootLogger } from '../observability/logger.js';
import { extractTraceparent, withSpan } from '../observability/trace.js';
import { todoService } from './todo-service.js';
import { sessionSSEService } from './session-sse.js';
import { sessionInteractionService } from './session-interaction-service.js';

const PERMISSION_REQUEST_CHANNEL = 'permission:request';
const PERMISSION_RESOLVED_CHANNEL = 'permission:resolved';

const logger = rootLogger.child({ component: 'permission-subscriber' });

interface PermissionRequestData {
  requestId: string;
  controllerId: string;
  sessionId: string;
  userId: string;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
    locations?: Array<{ path: string; line?: number }>;
  };
  options: Array<{ optionId: string; name: string; kind: string }>;
  _meta?: unknown;
}

interface PermissionResolvedData {
  requestId?: string;
  sessionId: string;
  reason: 'timeout' | 'cancelled';
  detail?: string;
  controllerId?: string;
  userId?: string;
  _meta?: unknown;
}

/**
 * 契约枚举 → 交互终态。未知 reason 收敛为 FAILED（链路异常）并告警，不静默按 cancelled 处理。
 */
const RESOLUTION_BY_REASON: Record<string, 'EXPIRED' | 'CANCELLED'> = {
  timeout: 'EXPIRED',
  cancelled: 'CANCELLED',
};

let subscriber: Redis | null = null;

export class PermissionSubscriberService {
  start(): void {
    if (subscriber) return;

    const redis = getRedisClient();
    subscriber = redis.duplicate();

    subscriber.subscribe(PERMISSION_REQUEST_CHANNEL, PERMISSION_RESOLVED_CHANNEL, (err) => {
      if (err) {
        logger.error(
          { err, channels: [PERMISSION_REQUEST_CHANNEL, PERMISSION_RESOLVED_CHANNEL] },
          'failed to subscribe to permission channels',
        );
        return;
      }
      logger.info(
        { channels: [PERMISSION_REQUEST_CHANNEL, PERMISSION_RESOLVED_CHANNEL] },
        'subscribed to permission channels',
      );
    });

    subscriber.on('message', async (channel: string, message: string) => {
      try {
        if (channel === PERMISSION_REQUEST_CHANNEL) {
          const data = JSON.parse(message) as PermissionRequestData;
          const parent = extractTraceparent(data._meta);
          await withSpan(
            `${PERMISSION_REQUEST_CHANNEL} handle`,
            {
              'messaging.destination.name': PERMISSION_REQUEST_CHANNEL,
              requestId: data.requestId,
              sessionId: data.sessionId,
              userId: data.userId,
            },
            async () => {
              await this.handlePermissionRequest(data);
            },
            { parent },
          );
        } else if (channel === PERMISSION_RESOLVED_CHANNEL) {
          const data = JSON.parse(message) as PermissionResolvedData;
          const parent = extractTraceparent(data._meta);
          await withSpan(
            `${PERMISSION_RESOLVED_CHANNEL} handle`,
            {
              'messaging.destination.name': PERMISSION_RESOLVED_CHANNEL,
              reason: data.reason,
              requestId: data.requestId ?? null,
              sessionId: data.sessionId,
            },
            async () => {
              await this.handlePermissionResolved(data);
            },
            { parent },
          );
        }
      } catch (err) {
        logger.error({ err, channel }, 'error handling permission message');
      }
    });
  }

  private async handlePermissionRequest(data: PermissionRequestData): Promise<void> {
    logger.debug({ event: 'received', requestId: data.requestId, sessionId: data.sessionId }, 'received permission request');

    const { interaction, created } = await sessionInteractionService.createFromPermissionRequest(data);
    if (!created) {
      logger.info({ event: 'duplicate', requestId: data.requestId }, 'duplicate permission request ignored');
      return;
    }

    // Create todo item（通知链路保持现状）
    const todo = await todoService.createPermissionTodo(data);
    logger.debug({ event: 'todo-created', requestId: data.requestId, todoId: String(todo._id) }, 'created permission todo');

    // Push SSE notification to user（通知 + 会话交互卡片事件）
    sessionSSEService.pushToUser(data.userId, {
      type: 'permission_request',
      data: {
        requestId: data.requestId,
        sessionId: data.sessionId,
        toolCallId: data.toolCall.toolCallId,
        toolCall: data.toolCall,
        options: data.options,
        todoId: todo._id,
        createdAt: todo.createdAt,
      },
    });
    sessionSSEService.pushToUser(data.userId, {
      type: 'session_interaction',
      data: {
        sessionId: data.sessionId,
        interactionId: interaction.interactionId,
        kind: 'PERMISSION',
        status: 'PENDING',
      },
    });
  }

  private async handlePermissionResolved(data: PermissionResolvedData): Promise<void> {
    const resolution = RESOLUTION_BY_REASON[data.reason];
    if (!resolution) {
      logger.warn(
        { event: 'unknown-reason', reason: data.reason, requestId: data.requestId ?? null },
        'permission resolved with unknown reason (fallback to failed)',
      );
    }
    const finalResolution = resolution ?? 'FAILED';

    // 租户隔离：没有归属用户的事件无法安全定位交互，拒绝写入并告警
    if (!data.userId) {
      logger.warn(
        { event: 'resolved-no-user', reason: data.reason, requestId: data.requestId ?? null },
        'permission resolved without userId, skip to avoid cross-tenant write',
      );
      return;
    }
    if (!data.requestId && !data.sessionId) {
      logger.warn({ event: 'resolved-no-target', reason: data.reason }, 'permission resolved without target');
      return;
    }

    const converged = await sessionInteractionService.resolve({
      userId: data.userId,
      interactionId: data.requestId,
      sessionId: data.sessionId,
      resolution: finalResolution,
      detail: data.detail,
    });

    // 通知已读收敛（待办列表/铃铛）
    await todoService.markTodoAsResponded(data.requestId ?? '', data.userId).catch((err: unknown) => {
      logger.warn({ err, requestId: data.requestId ?? null }, 'failed to mark permission todo as read');
    });

    if (converged > 0) {
      sessionSSEService.pushToUser(data.userId, {
        type: 'session_interaction',
        data: {
          sessionId: data.sessionId,
          interactionId: data.requestId ?? '',
          kind: 'PERMISSION',
          status: finalResolution,
        },
      });
    } else {
      logger.info(
        { event: 'resolved-skipped', reason: data.reason, requestId: data.requestId ?? null },
        'permission resolved write skipped (already terminal or tenant mismatch)',
      );
    }
  }

  stop(): void {
    if (subscriber) {
      subscriber.unsubscribe();
      subscriber.quit();
      subscriber = null;
    }
  }
}

export const permissionSubscriberService = new PermissionSubscriberService();
