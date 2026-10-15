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
  /** watch 重连退避基准（ms），默认 5000；<=0 关闭退避等待（测试用）。 */
  reconnectDelayMs?: number;
  /** watch 重连退避上限（ms），默认 60000。 */
  reconnectMaxDelayMs?: number;
  logger?: Logger;
}

const SCAN_INTERVAL_MS = 15000;
const MAX_WATCH_RETRY_EXPONENT = 5;
const DEFAULT_RECONNECT_BASE_MS = 5000;
const DEFAULT_RECONNECT_MAX_MS = 60000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Job 状态同步：watch 实时事件 + 断线重连全量对账 + connecting 超时巡检 + 心跳离线巡检
 * + 终态残留 Job 回收兜底。
 */
export class StatusSyncService {
  private unwatch: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watchRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchRetryAttempt = 0;
  private stopped = true;

  constructor(private readonly opts: StatusSyncOptions) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.attemptStartWatch();
    this.timer = setInterval(() => {
      void this.scanTimeouts().catch((err) => {
        this.opts.logger?.error?.('[status-sync] scanTimeouts failed', err);
      });
      void this.scanHeartbeats().catch((err) => {
        this.opts.logger?.error?.('[status-sync] scanHeartbeats failed', err);
      });
      void this.sweepTerminalJobs().catch((err) => {
        this.opts.logger?.error?.('[status-sync] terminal sweep failed', err);
      });
    }, SCAN_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** 尝试建立 watch；失败时记录并安排指数退避重试（不向外抛错，避免打挂进程/watch 断链）。 */
  private async attemptStartWatch(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.startWatch();
      this.watchRetryAttempt = 0;
      if (this.watchRetryTimer) {
        clearTimeout(this.watchRetryTimer);
        this.watchRetryTimer = null;
      }
    } catch (err) {
      this.opts.logger?.error?.('[status-sync] failed to establish watch, will retry', err);
      this.scheduleWatchRetry();
    }
  }

  /**
   * 计算下一次 watch 重连等待：指数退避（base × 2^attempt），带上限（建议 C）。
   * `reconnectDelayMs <= 0` 时返回 0（不等待，测试用）；每次调用递增 attempt，
   * watch 建立成功后由 `attemptStartWatch` 归零。
   */
  private nextReconnectDelay(): number {
    const base = this.opts.reconnectDelayMs ?? DEFAULT_RECONNECT_BASE_MS;
    const exponent = Math.min(this.watchRetryAttempt, MAX_WATCH_RETRY_EXPONENT);
    this.watchRetryAttempt += 1;
    if (base <= 0) return 0;
    const max = this.opts.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_MS;
    return Math.min(base * 2 ** exponent, max);
  }

  private scheduleWatchRetry(): void {
    if (this.stopped || this.watchRetryTimer) return;
    const delayMs = this.nextReconnectDelay();
    this.watchRetryTimer = setTimeout(() => {
      this.watchRetryTimer = null;
      void this.attemptStartWatch();
    }, delayMs);
    this.watchRetryTimer.unref?.();
  }

  async startWatch(): Promise<void> {
    this.unwatch = await this.opts.k8sClient.watchJobs(
      WORKER_LABEL_SELECTOR,
      (event) => {
        void this.handleJobEvent(event).catch((err) => {
          this.opts.logger?.error?.('[status-sync] handleJobEvent failed', err);
        });
      },
      (error) => {
        void this.handleWatchDisconnect(error).catch((err) => {
          this.opts.logger?.error?.('[status-sync] handleWatchDisconnect failed', err);
        });
      },
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.watchRetryTimer) {
      clearTimeout(this.watchRetryTimer);
      this.watchRetryTimer = null;
    }
    this.watchRetryAttempt = 0;
    try {
      this.unwatch?.();
    } catch {
      /* ignore */
    }
    this.unwatch = null;
  }

  /** watch 断开：记录 → 全量对账 → 自动重连（失败则退避重试）。 */
  async handleWatchDisconnect(error?: unknown): Promise<void> {
    this.opts.logger?.warn?.('[status-sync] watch disconnected, reconciling', error);
    try {
      this.unwatch?.();
    } catch {
      /* ignore */
    }
    this.unwatch = null;
    try {
      await this.reconcile();
    } catch (err) {
      this.opts.logger?.error?.('[status-sync] reconcile after disconnect failed', err);
    }
    if (this.stopped) return;
    // 断线重连同样采用指数退避（建议 C），而非固定延迟，避免 apiserver 抖动时反复冲击。
    const reconnectDelay = this.nextReconnectDelay();
    if (reconnectDelay > 0) await delay(reconnectDelay);
    if (!this.stopped) {
      await this.attemptStartWatch();
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
   * 全量对账：用 K8s 实际 Job 列表比对落库记录，回写状态并识别无主 Job；
   * 末尾回收终态记录残留的 Job（资源泄漏兜底）。
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

    await this.sweepTerminalJobs();
    return orphans;
  }

  /**
   * 终态残留 Job 巡检（问题 50）：
   * - `failed` / `exited` 记录若仍关联 Job（如销毁时 deleteJob 失败），删除 Job 回收节点资源；
   * - 卡死的 `destroying` 记录（销毁流程被 SIGTERM 打断）：回收残留 Job 并迁移 `exited`
   *   （契约 `destroying → exited`），即便 Job 已不存在也迁移。
   *
   * 使用一次 `listJobs()` 全量拉取后在内存索引匹配，避免逐记录 `getJob` 的 N+1。
   * 返回本次真实回收了 Job 的 containerId 列表。
   */
  async sweepTerminalJobs(): Promise<string[]> {
    const jobs = await this.opts.k8sClient.listJobs(WORKER_LABEL_SELECTOR);
    const byContainerId = new Map<string, K8sJobEvent['job']>();
    const byName = new Map<string, K8sJobEvent['job']>();
    for (const job of jobs) {
      byName.set(job.name, job);
      if (job.containerId) byContainerId.set(job.containerId, job);
    }

    const records = await this.opts.repo.findAll();
    const reclaimed: string[] = [];
    for (const record of records) {
      // 卡死的 destroying：无论 Job 是否还在都需迁移终态，故不做 Job 存在性前置过滤。
      if (record.status === 'destroying') {
        const deleted = await this.opts.containerService.reclaimResidualJob(record.id);
        if (deleted) reclaimed.push(record.id);
        continue;
      }
      if (record.status !== 'failed' && record.status !== 'exited') continue;
      const job = byContainerId.get(record.id) ?? byName.get(record.name);
      if (!job) continue;
      const deleted = await this.opts.containerService.reclaimResidualJob(record.id);
      if (deleted) reclaimed.push(record.id);
    }
    return reclaimed;
  }

  /**
   * connecting 超时巡检：超过 CONNECT_TIMEOUT_MS 未回连 → failed + exitReason「回连超时」，
   * 不立即删除 Job（等待管理员强制销毁或终态巡检兜底回收）。
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
