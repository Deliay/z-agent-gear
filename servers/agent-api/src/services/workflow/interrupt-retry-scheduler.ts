import { WorkflowInstance } from '../../models/workflow-instance.js';
import { logger as rootLogger } from '../../observability/logger.js';
import { KeyedMutex } from '../keyed-mutex.js';
import {
  executeScheduledRetry,
  scheduleInterruptionRetry,
} from './interrupt-retry.js';

const logger = rootLogger.child({ component: 'interrupt-retry-scheduler' });

/** 扫描周期（PRD 3.2：退避粒度 1 分钟，30s 轮询足够且代价低） */
export const INTERRUPT_RETRY_POLL_INTERVAL_MS = 30_000;

/** 单轮最多处理的实例数（避免异常堆积拖垮单轮） */
const SCAN_LIMIT = 50;

interface SchedulerNodeLike {
  nodeId: string;
  sessionId?: unknown;
  status?: string;
  retryPhase?: string | null;
  retryTrigger?: string | null;
  nextRetryAt?: Date | null;
  retryDeadlineAt?: Date | null;
}

interface SchedulerInstanceLike {
  _id: { toString(): string };
  nodes: SchedulerNodeLike[];
}

/**
 * 中断自动重试周期调度器（仿 IssuesTriggerRunner 范式）。
 *
 * - 扫描 A：`retryPhase=SCHEDULED` 且 `nextRetryAt<=now` → 执行重试管线；
 * - 扫描 B：`retryPhase=RECONNECTING` 且 `retryDeadlineAt<=now` → 重排（进程重启丢等待器兜底）；
 * - `scanning` 互斥保证单轮不重叠；每节点 `KeyedMutex` 串行，避免并发重复 resume；
 * - `timer.unref()` 不阻塞进程退出。
 *
 * **单实例部署约束**：与 KeyedMutex 同口径，多副本会重复执行同一节点的重试。
 */
export class InterruptRetryScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private readonly mutex = new KeyedMutex();
  private readonly pollIntervalMs: number;

  constructor(options: { pollIntervalMs?: number } = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? INTERRUPT_RETRY_POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    // 启动即扫一轮：进程重启后立即拾起到期排期
    void this.scan();
    this.timer = setInterval(() => {
      void this.scan();
    }, this.pollIntervalMs);
    this.timer.unref?.();
    logger.info({ event: 'scheduler-started', pollIntervalMs: this.pollIntervalMs }, 'interrupt retry scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 扫描一轮（并发安全：单轮不重叠；单条失败不影响其余） */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const now = new Date();
      const due = (await WorkflowInstance.find({
        deletedAt: null,
        nodes: {
          $elemMatch: {
            status: { $in: ['RUNNING', 'REWORK'] },
            retryPhase: 'SCHEDULED',
            nextRetryAt: { $lte: now },
          },
        },
      })
        .limit(SCAN_LIMIT)
        .lean()) as unknown as SchedulerInstanceLike[];

      for (const instance of due) {
        const instanceId = instance._id.toString();
        for (const node of instance.nodes) {
          if (!isDueScheduled(node, now)) continue;
          await this.runGuarded(instanceId, node.nodeId, 'retry-executed', () =>
            executeScheduledRetry(instanceId, node.nodeId),
          );
        }
      }

      const stale = (await WorkflowInstance.find({
        deletedAt: null,
        nodes: {
          $elemMatch: {
            status: { $in: ['RUNNING', 'REWORK'] },
            retryPhase: 'RECONNECTING',
            retryDeadlineAt: { $lte: now },
          },
        },
      })
        .limit(SCAN_LIMIT)
        .lean()) as unknown as SchedulerInstanceLike[];

      for (const instance of stale) {
        const instanceId = instance._id.toString();
        for (const node of instance.nodes) {
          if (!isStaleReconnecting(node, now)) continue;
          const sessionId = node.sessionId?.toString();
          if (!sessionId) continue;
          const trigger = node.retryTrigger === 'IDLED' ? 'IDLED' : 'ENDED';
          await this.runGuarded(instanceId, node.nodeId, 'retry-rescheduled', async () => {
            await scheduleInterruptionRetry({
              instanceId,
              nodeId: node.nodeId,
              sessionId,
              trigger,
              expectedPhase: 'RECONNECTING',
            });
          });
        }
      }

      logger.debug({ event: 'scan', dueCount: due.length, staleCount: stale.length }, 'interrupt retry scan finished');
    } catch (err) {
      logger.warn({ event: 'scan-failed', err }, 'interrupt retry scan failed');
    } finally {
      this.scanning = false;
    }
  }

  private async runGuarded(
    instanceId: string,
    nodeId: string,
    stage: string,
    task: () => Promise<void>,
  ): Promise<void> {
    try {
      await this.mutex.runExclusive(`interrupt-retry:${instanceId}:${nodeId}`, task);
    } catch (err) {
      logger.warn({ event: 'retry-failed', instanceId, nodeId, stage, err }, 'interrupt retry item failed');
    }
  }
}

function isDueScheduled(node: SchedulerNodeLike, now: Date): boolean {
  return (
    (node.status === 'RUNNING' || node.status === 'REWORK') &&
    node.retryPhase === 'SCHEDULED' &&
    node.nextRetryAt instanceof Date &&
    node.nextRetryAt.getTime() <= now.getTime()
  );
}

function isStaleReconnecting(node: SchedulerNodeLike, now: Date): boolean {
  return (
    (node.status === 'RUNNING' || node.status === 'REWORK') &&
    node.retryPhase === 'RECONNECTING' &&
    node.retryDeadlineAt instanceof Date &&
    node.retryDeadlineAt.getTime() <= now.getTime()
  );
}

export const interruptRetryScheduler = new InterruptRetryScheduler();
