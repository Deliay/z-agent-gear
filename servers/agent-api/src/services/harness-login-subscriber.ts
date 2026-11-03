import type { Redis } from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { logger as rootLogger } from '../observability/logger.js';
import { extractTraceparent, withSpan } from '../observability/trace.js';
import { todoService, type ElicitationResolution } from './todo-service.js';
import { sessionSSEService } from './session-sse.js';

const HARNESS_LOGIN_REQUIRED_CHANNEL = 'harness:login:required';
const HARNESS_LOGIN_RESOLVED_CHANNEL = 'harness:login:resolved';

const logger = rootLogger.child({ component: 'harness-login-subscriber' });

interface HarnessLoginRequiredData {
  requestId: string;
  controllerId: string;
  userId: string;
  sessionId?: string;
  serverType: string;
  trigger: string;
  url: string;
  userCode: string;
  expiresInSeconds?: number;
  receivedAt?: number | string;
  _meta?: unknown;
}

type HarnessLoginResult = 'succeeded' | 'failed' | 'cancelled' | 'expired';

interface HarnessLoginResolvedData {
  requestId: string;
  controllerId?: string;
  userId: string;
  result: HarnessLoginResult;
  account?: string;
  error?: string;
  _meta?: unknown;
}

/**
 * 契约 result → 待办终态（沿用既有 resolution 枚举，不新增枚举值）：
 * succeeded→accepted、cancelled→cancelled、expired→expired、failed/未知→failed。
 */
const RESOLUTION_BY_RESULT: Record<string, ElicitationResolution> = {
  succeeded: 'accepted',
  cancelled: 'cancelled',
  expired: 'expired',
  failed: 'failed',
};

export class HarnessLoginSubscriberService {
  private subscriber: Redis | null = null;

  start(): void {
    if (this.subscriber) return;

    const redis = getRedisClient();
    this.subscriber = redis.duplicate();

    this.subscriber.subscribe(
      HARNESS_LOGIN_REQUIRED_CHANNEL,
      HARNESS_LOGIN_RESOLVED_CHANNEL,
      (err) => {
        if (err) {
          logger.error({ err }, 'failed to subscribe to harness login channels');
          return;
        }
        logger.info({}, 'subscribed to harness:login:required and harness:login:resolved channels');
      },
    );

    this.subscriber.on('message', async (channel: string, message: string) => {
      try {
        if (channel === HARNESS_LOGIN_REQUIRED_CHANNEL) {
          const data = JSON.parse(message) as HarnessLoginRequiredData;
          await withSpan(
            `${HARNESS_LOGIN_REQUIRED_CHANNEL} handle`,
            { 'messaging.destination.name': channel, requestId: data.requestId },
            async () => {
              await this.handleRequired(data);
            },
            { parent: extractTraceparent(data._meta) },
          );
        } else if (channel === HARNESS_LOGIN_RESOLVED_CHANNEL) {
          const data = JSON.parse(message) as HarnessLoginResolvedData;
          await withSpan(
            `${HARNESS_LOGIN_RESOLVED_CHANNEL} handle`,
            { 'messaging.destination.name': channel, requestId: data.requestId, result: data.result },
            async () => {
              await this.handleResolved(data);
            },
            { parent: extractTraceparent(data._meta) },
          );
        }
      } catch (err) {
        logger.error({ err, channel }, 'error handling harness login message');
      }
    });
  }

  private async handleRequired(data: HarnessLoginRequiredData): Promise<void> {
    // 租户隔离：缺 userId 的 required 无法安全落库/下发，直接丢弃并告警
    if (!data.userId || !data.requestId) {
      logger.warn(
        { event: 'required-no-target', requestId: data.requestId ?? null },
        'required event without userId/requestId, skip',
      );
      return;
    }

    const { todo, created } = await todoService.createHarnessLoginTodo(data);
    logger.debug({ event: 'required', requestId: data.requestId, created }, 'harness login required');

    // 幂等：重复 required 不重复推送（todo 已存在）
    if (!created) return;

    const loginData = (todo as unknown as { harnessLoginData?: { expiresAt?: Date | string } }).harnessLoginData;
    const expiresAt = loginData?.expiresAt
      ? new Date(loginData.expiresAt).toISOString()
      : new Date(Date.now() + 1800_000).toISOString();

    sessionSSEService.pushToUser(data.userId, {
      type: 'harness_login_required',
      data: {
        requestId: data.requestId,
        controllerId: data.controllerId,
        serverType: data.serverType,
        trigger: data.trigger,
        url: data.url,
        userCode: data.userCode,
        expiresAt,
        todoId: String((todo as unknown as { _id?: unknown })._id ?? ''),
      },
    });
  }

  private async handleResolved(data: HarnessLoginResolvedData): Promise<void> {
    if (!data.userId || !data.requestId) {
      logger.warn(
        { event: 'resolved-no-target', requestId: data.requestId ?? null },
        'resolved event without userId/requestId, skip to avoid cross-tenant write',
      );
      return;
    }

    const resolution = RESOLUTION_BY_RESULT[data.result];
    if (!resolution) {
      logger.warn(
        { event: 'resolved-unknown-result', result: data.result, requestId: data.requestId },
        'resolved with unknown result (fallback to failed)',
      );
    }
    const finalResolution = resolution ?? 'failed';
    const sseResult: HarnessLoginResult = resolution ? data.result : 'failed';

    const updated = await todoService.markHarnessLoginResolved(data.requestId, finalResolution, {
      userId: data.userId,
    });
    // 已终结（单调守卫）或归属不匹配：正常幂等场景
    if (updated === 0) {
      logger.warn(
        { event: 'resolved-skipped', requestId: data.requestId },
        'resolved write skipped (already terminal or tenant mismatch)',
      );
    }
    await todoService.markTodoAsResponded(data.requestId, data.userId);

    sessionSSEService.pushToUser(data.userId, {
      type: 'harness_login_resolved',
      data: {
        requestId: data.requestId,
        result: sseResult,
        ...(data.account ? { account: data.account } : {}),
        ...(data.error ? { error: data.error } : {}),
      },
    });
  }

  stop(): void {
    if (this.subscriber) {
      this.subscriber.unsubscribe();
      this.subscriber.quit();
      this.subscriber = null;
    }
  }
}

export const harnessLoginSubscriberService = new HarnessLoginSubscriberService();
