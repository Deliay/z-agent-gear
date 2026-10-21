import type { Redis } from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { todoService } from './todo-service.js';
import { sessionSSEService } from './session-sse.js';

const ELICITATION_REQUEST_CHANNEL = 'elicitation:request';
const ELICITATION_COMPLETE_CHANNEL = 'elicitation:complete';
const ELICITATION_RESOLVED_CHANNEL = 'elicitation:resolved';

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
}

interface ElicitationCompleteData {
  sessionId: string;
  elicitationId: string;
  userId: string;
}

interface ElicitationResolvedData {
  requestId?: string;
  sessionId: string;
  reason: 'unsupported_mode' | 'timeout' | 'cancelled';
  detail?: string;
  userId?: string;
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
          console.error('Failed to subscribe to elicitation channels:', err);
          return;
        }
        console.log('Subscribed to elicitation:request, elicitation:complete and elicitation:resolved channels');
      },
    );

    this.subscriber.on('message', async (channel: string, message: string) => {
      try {
        if (channel === ELICITATION_REQUEST_CHANNEL) {
          await this.handleElicitationRequest(JSON.parse(message) as ElicitationRequestData);
        } else if (channel === ELICITATION_COMPLETE_CHANNEL) {
          await this.handleElicitationComplete(JSON.parse(message) as ElicitationCompleteData);
        } else if (channel === ELICITATION_RESOLVED_CHANNEL) {
          await this.handleElicitationResolved(JSON.parse(message) as ElicitationResolvedData);
        }
      } catch (err) {
        console.error('Error handling elicitation message:', err);
      }
    });
  }

  private async handleElicitationRequest(data: ElicitationRequestData): Promise<void> {
    console.log('Received elicitation request:', data.requestId);

    // Create todo item
    const todo = await todoService.createElicitationTodo(data);
    console.log('Created todo:', todo._id);

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
    console.log('Received elicitation complete:', data.elicitationId);

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
      console.warn(
        '[Elicitation] resolved with unknown reason=%j requestId=%s (fallback to failed)',
        data.reason,
        data.requestId ?? 'n/a',
      );
    }
    const finalResolution = resolution ?? 'failed';

    console.log('[Elicitation] resolved reason=%s requestId=%s', data.reason, data.requestId ?? 'n/a');

    // 租户隔离：没有归属用户的事件无法安全定位待办，拒绝写入并告警
    if (!data.userId) {
      console.warn(
        '[Elicitation] resolved event without userId, skip to avoid cross-tenant write: reason=%s requestId=%s',
        data.reason,
        data.requestId ?? 'n/a',
      );
      return;
    }

    // requestId 缺失（旧 controller / unsupported_mode 早期事件）时按 sessionId 兜底收敛
    if (!data.requestId && !data.sessionId) {
      console.warn('[Elicitation] resolved event without requestId and sessionId, nothing to converge');
      return;
    }

    const updated = await todoService.markElicitationResolved(data.requestId, finalResolution, {
      userId: data.userId,
      sessionId: data.sessionId,
    });
    if (updated === 0) {
      // 已终结（单调守卫）或归属不匹配：正常幂等场景，仅留痕便于排查
      console.warn(
        '[Elicitation] resolved write skipped (already terminal or tenant mismatch): reason=%s requestId=%s',
        data.reason,
        data.requestId ?? 'n/a',
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
