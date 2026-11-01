import type { Redis } from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { logger as rootLogger } from '../observability/logger.js';
import { extractTraceparent, withSpan } from '../observability/trace.js';
import { sessionService } from './session.js';

const SESSION_STATUS_CHANNEL = 'session:status';

const logger = rootLogger.child({ component: 'session-lifecycle-subscriber' });

/**
 * 会话生命周期事件订阅（工作流编排感知层）。
 *
 * controller-api 直接写 Mongo 并 publish `session:status`，agent-api 需要
 * 在服务启动时持续感知两类事件（不能依赖 SSE 连接是否存在）：
 * - `removed`：start/resume 失败被清理 → 通知编排器升级节点失败（SESSION_START_FAILED）；
 * - `idling` + `promptCompleted`：turn 结束 → 工作流节点会话停滞检测（空闲未推进则兜底/升级）。
 */
export class SessionLifecycleSubscriber {
  private subscriber: Redis | null = null;

  start(): void {
    if (this.subscriber) return;

    this.subscriber = getRedisClient().duplicate();
    this.subscriber.subscribe(SESSION_STATUS_CHANNEL).catch((err: Error) => {
      logger.error({ err, channel: SESSION_STATUS_CHANNEL }, 'failed to subscribe to session status channel');
    });

    this.subscriber.on('message', async (_channel: string, message: string) => {
      let parsed: { sessionId?: string; status?: string; promptCompleted?: boolean; _meta?: unknown };
      try {
        parsed = JSON.parse(message);
      } catch {
        return;
      }
      if (!parsed.sessionId || !parsed.status) return;

      const handled = parsed.status === 'removed' || (parsed.status === 'idling' && parsed.promptCompleted === true);
      if (!handled) return;

      const parent = extractTraceparent(parsed._meta);
      await withSpan(
        `${SESSION_STATUS_CHANNEL} handle`,
        { 'messaging.destination.name': SESSION_STATUS_CHANNEL, sessionId: parsed.sessionId, status: parsed.status },
        async () => {
          try {
            if (parsed.status === 'removed') {
              await sessionService.notifySessionRemoved(parsed.sessionId as string);
            } else {
              await sessionService.notifySessionIdled(parsed.sessionId as string);
            }
          } catch (err) {
            logger.error({ err, sessionId: parsed.sessionId, status: parsed.status }, 'failed to handle lifecycle event');
          }
        },
        { parent },
      );
    });
  }

  async stop(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(SESSION_STATUS_CHANNEL);
      this.subscriber.disconnect();
      this.subscriber = null;
    }
  }
}

export const sessionLifecycleSubscriber = new SessionLifecycleSubscriber();
