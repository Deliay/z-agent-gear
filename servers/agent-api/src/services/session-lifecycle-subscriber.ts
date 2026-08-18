import type { Redis } from 'ioredis';
import { getRedisClient } from '../middleware/redis.js';
import { sessionService } from './session.js';

const SESSION_STATUS_CHANNEL = 'session:status';

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
      console.error(`Failed to subscribe to ${SESSION_STATUS_CHANNEL}:`, err.message);
    });

    this.subscriber.on('message', async (_channel: string, message: string) => {
      let parsed: { sessionId?: string; status?: string; promptCompleted?: boolean };
      try {
        parsed = JSON.parse(message);
      } catch {
        return;
      }
      if (!parsed.sessionId || !parsed.status) return;

      try {
        if (parsed.status === 'removed') {
          await sessionService.notifySessionRemoved(parsed.sessionId);
        } else if (parsed.status === 'idling' && parsed.promptCompleted === true) {
          await sessionService.notifySessionIdled(parsed.sessionId);
        }
      } catch (err) {
        console.error(`Failed to handle lifecycle event for session ${parsed.sessionId}:`, (err as Error).message);
      }
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
