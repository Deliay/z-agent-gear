import { isTerminalStatus } from '../models/cloud-container.js';
import type { ContainerRepository } from '../repositories/container-repository.js';
import type { ContainerService } from './container-service.js';
import type { HeartbeatTracker } from './heartbeat-tracker.js';
import type { K8sClient, K8sJobEvent } from './k8s-client.js';
import { WORKER_LABEL_SELECTOR } from './k8s-job-manager.js';

interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface StatusSyncOptions {
  repo: ContainerRepository;
  k8sClient: K8sClient;
  containerService: ContainerService;
  heartbeatTracker: HeartbeatTracker;
  connectTimeoutMs: number;
  image: string;
  reconnectDelayMs?: number;
  logger?: Logger;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Job 状态同步：watch 实时事件 + 断线重连全量对账 + connecting 超时巡检 + 心跳离线巡检。
 */
export class StatusSyncService {
  private unwatch: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;

  constructor(private readonly opts: StatusSyncOptions) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.startWatch();
    this.timer = setInterval(() => {
      void this.scanTimeouts();
      void this.scanHeartbeats();
    }, 15000);
    this.timer.unref?.();
  }

  async startWatch(): Promise<void> {
    this.unwatch = await this.opts.k8sClient.watchJobs(
      WORKER_LABEL_SELECTOR,
      (event) => {
        void this.handleJobEvent(event);
      },
      (error) => {
        void this.handleWatchDisconnect(error);
      },
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.unwatch?.();
    } catch {
      /* ignore */
    }
    this.unwatch = null;
  }

  /** watch 断开：记录 → 全量对账 → 自动重连。 */
  async handleWatchDisconnect(error?: unknown): Promise<void> {
    this.opts.logger?.warn?.('[status-sync] watch disconnected, reconciling', error);
    try {
      this.unwatch?.();
    } catch {
      /* ignore */
    }
    this.unwatch = null;
    await this.reconcile();
    if (this.stopped) return;
    const reconnectDelay = this.opts.reconnectDelayMs ?? 5000;
    if (reconnectDelay > 0) await delay(reconnectDelay);
    if (!this.stopped) {
      await this.startWatch();
    }
  }

  async handleJobEvent(event: K8sJobEvent): Promise<void> {
    const containerId = event.job.containerId;
    let record = containerId ? await this.opts.repo.findById(containerId) : null;
    if (!record) {
      record = await this.opts.repo.findByName(event.job.name);
    }

    if (!record) {
      if (event.type === 'DELETED') return;
      // 无主 Job（落库失败产生）：创建 failed 记录供人工清理。
      await this.opts.repo.create({
        name: event.job.name,
        namespace: event.job.namespace,
        purpose: 'idle',
        image: this.opts.image,
        status: 'failed',
        exitReason: '孤儿 Job',
      });
      this.opts.logger?.warn?.(`[status-sync] orphan job detected: ${event.job.name}`);
      return;
    }

    if (record.status === 'destroying' || isTerminalStatus(record.status)) return;

    if (event.type === 'DELETED') {
      if (record.status === 'online') {
        await this.opts.containerService.markExited(record.id, 'Job 已删除');
      } else {
        await this.opts.containerService.markFailed(record.id, 'Job 已删除');
      }
      return;
    }

    if (event.job.phase === 'failed') {
      await this.opts.containerService.markFailed(
        record.id,
        event.job.message ?? '容器异常退出',
      );
    } else if (event.job.phase === 'succeeded') {
      await this.opts.containerService.markExited(record.id, '容器正常退出');
    }
  }

  /**
   * 全量对账：用 K8s 实际 Job 列表比对落库记录，回写状态并识别无主 Job。
   */
  async reconcile(): Promise<string[]> {
    const jobs = await this.opts.k8sClient.listJobs(WORKER_LABEL_SELECTOR);
    const byContainerId = new Map<string, K8sJobEvent['job']>();
    for (const job of jobs) {
      if (job.containerId) byContainerId.set(job.containerId, job);
    }

    const records = await this.opts.repo.findAll();

    for (const record of records) {
      if (record.status === 'destroying' || isTerminalStatus(record.status)) continue;
      const job = byContainerId.get(record.id) ?? (await this.opts.k8sClient.getJob(record.name));
      if (!job) {
        await this.opts.containerService.markFailed(record.id, 'Job 已回收');
        continue;
      }
      if (job.phase === 'failed') {
        await this.opts.containerService.markFailed(record.id, job.message ?? '容器异常退出');
      } else if (job.phase === 'succeeded') {
        await this.opts.containerService.markExited(record.id, '容器正常退出');
      }
    }

    const knownIds = new Set(records.map((r) => r.id));
    const orphans: string[] = [];
    for (const job of jobs) {
      if (!job.containerId || knownIds.has(job.containerId)) continue;
      orphans.push(job.name);
      await this.opts.repo.create({
        name: job.name,
        namespace: job.namespace,
        purpose: 'idle',
        image: this.opts.image,
        status: 'failed',
        exitReason: '孤儿 Job',
      });
      this.opts.logger?.warn?.(`[status-sync] orphan job detected during reconcile: ${job.name}`);
    }
    return orphans;
  }

  /**
   * connecting 超时巡检：超过 CONNECT_TIMEOUT_MS 未回连 → failed + exitReason「回连超时」，
   * 不自动删除 Job（等待管理员强制销毁）。
   */
  async scanTimeouts(now: number = Date.now()): Promise<string[]> {
    const records = await this.opts.repo.findAll();
    const timedOut: string[] = [];
    for (const record of records) {
      if (record.status !== 'connecting') continue;
      if (now - record.updatedAt.getTime() >= this.opts.connectTimeoutMs) {
        await this.opts.containerService.markFailed(record.id, '回连超时');
        timedOut.push(record.id);
      }
    }
    return timedOut;
  }

  /**
   * 心跳离线巡检：online 容器连续 3 次（约 90s）未收到心跳 → 退回 connecting 等待重连。
   */
  async scanHeartbeats(now: number = Date.now()): Promise<string[]> {
    const records = await this.opts.repo.findAll();
    const offline: string[] = [];
    for (const record of records) {
      if (record.status !== 'online') continue;
      if (!this.opts.heartbeatTracker.has(record.id)) {
        this.opts.heartbeatTracker.record(
          record.id,
          record.connectedAt?.getTime() ?? now,
        );
      }
      if (this.opts.heartbeatTracker.isStale(record.id, now)) {
        await this.opts.containerService.markConnecting(record.id);
        this.opts.heartbeatTracker.remove(record.id);
        offline.push(record.id);
      }
    }
    return offline;
  }
}
