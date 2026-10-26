import type { Redis } from 'ioredis';
import { getRedisClient } from '../../middleware/redis.js';
import { WorkflowInstance } from '../../models/workflow-instance.js';
import { prHandlerRegistry } from './pr-handler-registry.js';
import {
  captureSnapshot,
  parseTodoEntries,
  syncTodoPanel,
  type TodoEntry,
} from './pr-check-run-sync.js';
import type { WorkflowInstanceDoc } from './engine.js';

const SESSION_MESSAGE_CHANNEL = 'session:message';

/**
 * todo panel（ACP plan）中央订阅：把工作流节点会话的任务清单投影到 check-run 子项。
 *
 * 四条件（PRD 功能点 2）：
 * 1. `message.type === 'plan'`（前置类型过滤，避免非工作流消息查库放大）；
 * 2. 会话属于工作流实例节点且实例未删除；
 * 3. 该节点已绑定 Pull Request（存在登记）；
 * 4. 当前提交曾写入过本节点 check-run（`lastCheckRunId` 非空）。
 *
 * 全链路 try/catch 收口，永不抛出；注销后（登记已删）自然零写入。
 */
export class PrCheckRunSubscriber {
  private subscriber: Redis | null = null;

  start(): void {
    if (this.subscriber) return;
    const subscriber = getRedisClient().duplicate();
    this.subscriber = subscriber;

    subscriber.subscribe(SESSION_MESSAGE_CHANNEL).catch((err: Error) => {
      console.error(`Failed to subscribe to ${SESSION_MESSAGE_CHANNEL}:`, err.message);
    });

    subscriber.on('message', (channel: string, message: string) => {
      if (channel !== SESSION_MESSAGE_CHANNEL) return;
      void this.handleMessage(message);
    });
  }

  async stop(): Promise<void> {
    if (!this.subscriber) return;
    const subscriber = this.subscriber;
    this.subscriber = null;
    try {
      await subscriber.unsubscribe(SESSION_MESSAGE_CHANNEL);
    } catch {
      // ignore
    }
    subscriber.disconnect();
  }

  /** 处理一条 `session:message` 载荷（导出让单测覆盖四条件） */
  async handleMessage(raw: string): Promise<void> {
    const payload = parsePayload(raw);
    if (!payload) return;
    const { sessionId, message } = payload;
    // 条件 1：先做类型过滤（轻量）
    if (message.type !== 'plan') return;

    const entries = parseTodoEntries(message.content);
    if (!entries) {
      console.warn('[pr-check-run] ignored invalid plan payload');
      return;
    }
    await this.syncForSession(sessionId, entries);
  }

  private async syncForSession(sessionId: string, entries: TodoEntry[]): Promise<void> {
    try {
      // 条件 2：会话属于工作流实例节点（deletedAt 为空 + 登记在库）
      const instance = (await WorkflowInstance.findOne({
        'nodes.sessionId': sessionId,
        deletedAt: null,
      })) as unknown as WorkflowInstanceDoc | null;
      if (!instance) return;
      const node = instance.nodes.find((n) => n.sessionId?.toString() === sessionId);
      if (!node) return;

      // 条件 3：节点已绑定 PR
      const handler = await prHandlerRegistry.findByNode(instance._id.toString(), node.nodeId);
      if (!handler) return;

      const snapshot = captureSnapshot(instance, node, handler);

      // 条件 4：当前提交曾写入过 check-run
      if (!snapshot.lastCheckRunId) return;

      await syncTodoPanel(snapshot, entries);
    } catch (err) {
      console.warn('[pr-check-run] todo sync failed:', (err as Error)?.message);
    }
  }
}

interface SessionMessagePayload {
  sessionId: string;
  message: { type?: unknown; content?: unknown };
}

function parsePayload(raw: string): SessionMessagePayload | null {
  try {
    const parsed = JSON.parse(raw) as {
      sessionId?: unknown;
      message?: { type?: unknown; content?: unknown };
    };
    if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null;
    if (!parsed.message || typeof parsed.message !== 'object') return null;
    return { sessionId: parsed.sessionId, message: parsed.message };
  } catch {
    return null;
  }
}

export const prCheckRunSubscriber = new PrCheckRunSubscriber();
