import type { Redis } from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { logger as rootLogger } from '../observability/logger.js';
import { extractTraceparent, withSpan } from '../observability/trace.js';
import { todoService } from './todo-service.js';
import { sessionSSEService } from './session-sse.js';

const ELICITATION_REQUEST_CHANNEL = 'elicitation:request';
const ELICITATION_COMPLETE_CHANNEL = 'elicitation:complete';
const ELICITATION_RESOLVED_CHANNEL = 'elicitation:resolved';

const logger = rootLogger.child({ component: 'elicitation-subscriber' });

interface ElicitationRequestData {
  requestId: string;
  controllerId: string;
  sessionId: string;
  userId: string;
  mode: 'form' | 'url';
  message: string;
  toolCallId?: string;
  requestedSchema?: { title?: string } & Record<string, unknown>;
  elicitationId?: string;
  url?: string;
  _meta?: unknown;
}

interface ElicitationCompleteData {
  sessionId: string;
  elicitationId: string;
  userId: string;
  _meta?: unknown;
}

interface ElicitationResolvedData {
  requestId?: string;
  sessionId: string;
  reason: 'unsupported_mode' | 'timeout' | 'cancelled';
  detail?: string;
  userId?: string;
  _meta?: unknown;
}

/**
 * 契约枚举 → 待办终态。未知 reason 归入 failed（链路异常），并留下可观测告警，
 * 不静默按 cancelled 处理。
 */
const RESOLUTION_BY_REASON: Record<string, 'failed' | 'expired' | 'cancelled'> = {
  unsupported_mode: 'failed',
  timeout: 'expired',
  cancelled: 'cancelled',
};

export class ElicitationSubscriberService {
  private subscriber: Redis | null = null;

  start(): void {
    if (this.subscriber) return;

    const redis = getRedisClient();
    this.subscriber = redis.duplicate();

    this.subscriber.subscribe(
      ELICITATION_REQUEST_CHANNEL,
      ELICITATION_COMPLETE_CHANNEL,
      ELICITATION_RESOLVED_CHANNEL,
      (err) => {
        if (err) {
          logger.error({ err }, 'failed to subscribe to elicitation channels');
          return;
        }
        logger.info({}, 'subscribed to elicitation:request, elicitation:complete and elicitation:resolved channels');
      },
    );

    this.subscriber.on('message', async (channel: string, message: string) => {
      try {
        if (channel === ELICITATION_REQUEST_CHANNEL) {
          const data = JSON.parse(message) as ElicitationRequestData;
          await withSpan(
            `${ELICITATION_REQUEST_CHANNEL} handle`,
            { 'messaging.destination.name': channel, requestId: data.requestId, sessionId: data.sessionId },
            async () => {
              await this.handleElicitationRequest(data);
            },
            { parent: extractTraceparent(data._meta) },
          );
        } else if (channel === ELICITATION_COMPLETE_CHANNEL) {
          const data = JSON.parse(message) as ElicitationCompleteData;
          await withSpan(
            `${ELICITATION_COMPLETE_CHANNEL} handle`,
            { 'messaging.destination.name': channel, elicitationId: data.elicitationId, sessionId: data.sessionId },
            async () => {
              await this.handleElicitationComplete(data);
            },
            { parent: extractTraceparent(data._meta) },
          );
        } else if (channel === ELICITATION_RESOLVED_CHANNEL) {
          const data = JSON.parse(message) as ElicitationResolvedData;
          await withSpan(
            `${ELICITATION_RESOLVED_CHANNEL} handle`,
            { 'messaging.destination.name': channel, reason: data.reason, requestId: data.requestId ?? null },
            async () => {
              await this.handleElicitationResolved(data);
            },
            { parent: extractTraceparent(data._meta) },
          );
        }
      } catch (err) {
        logger.error({ err, channel }, 'error handling elicitation message');
      }
    });
  }

  private async handleElicitationRequest(data: ElicitationRequestData): Promise<void> {
    logger.debug({ event: 'received', requestId: data.requestId }, 'received elicitation request');

    // Create todo item
    const todo = await todoService.createElicitationTodo(data);
    logger.debug({ event: 'todo-created', requestId: data.requestId, todoId: String(todo._id) }, 'created elicitation todo');

    // Push SSE notification to user
    sessionSSEService.pushToUser(data.userId, {
      type: 'elicitation_request',
      data: {
        requestId: data.requestId,
        sessionId: data.sessionId,
        toolCallId: data.toolCallId,
        mode: data.mode,
        message: data.message,
        requestedSchema: data.requestedSchema,
        elicitationId: data.elicitationId,
        url: data.url,
        todoId: todo._id,
        createdAt: todo.createdAt,
      },
    });
  }

  private async handleElicitationComplete(data: ElicitationCompleteData): Promise<void> {
    logger.debug({ event: 'complete-received', elicitationId: data.elicitationId }, 'received elicitation complete');

    // Mark the matching elicitation todo as read（按 userId 限定归属）
    await todoService.markElicitationCompleted(data.elicitationId, data.userId);

    // Push SSE notification to user
    sessionSSEService.pushToUser(data.userId, {
      type: 'elicitation_complete',
      data: {
        elicitationId: data.elicitationId,
      },
    });
  }

  private async handleElicitationResolved(data: ElicitationResolvedData): Promise<void> {
    const resolution = RESOLUTION_BY_REASON[data.reason];
    if (!resolution) {
      // 运行时校验：契约外 reason 不静默归并，收敛为 failed 并告警
      logger.warn(
        { event: 'unknown-reason', reason: data.reason, requestId: data.requestId ?? null },
        'resolved with unknown reason (fallback to failed)',
      );
    }
    const finalResolution = resolution ?? 'failed';

    logger.info(
      { event: 'resolved', reason: data.reason, requestId: data.requestId ?? null },
      'elicitation resolved',
    );

    // 租户隔离：没有归属用户的事件无法安全定位待办，拒绝写入并告警
    if (!data.userId) {
      logger.warn(
        { event: 'resolved-no-user', reason: data.reason, requestId: data.requestId ?? null },
        'resolved event without userId, skip to avoid cross-tenant write',
      );
      return;
    }

    // requestId 缺失（旧 controller / unsupported_mode 早期事件）时按 sessionId 兜底收敛
    if (!data.requestId && !data.sessionId) {
      logger.warn(
        { event: 'resolved-no-target', reason: data.reason },
        'resolved event without requestId and sessionId, nothing to converge',
      );
      return;
    }

    const updated = await todoService.markElicitationResolved(data.requestId, finalResolution, {
      userId: data.userId,
      sessionId: data.sessionId,
    });
    if (updated === 0) {
      // 已终结（单调守卫）或归属不匹配：正常幂等场景，仅留痕便于排查
      logger.warn(
        { event: 'resolved-skipped', reason: data.reason, requestId: data.requestId ?? null },
        'resolved write skipped (already terminal or tenant mismatch)',
      );
    }
  }

  stop(): void {
    if (this.subscriber) {
      this.subscriber.unsubscribe();
      this.subscriber.quit();
      this.subscriber = null;
    }
  }
}

export const elicitationSubscriberService = new ElicitationSubscriberService();
