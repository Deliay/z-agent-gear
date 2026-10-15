import {
  isTerminalStatus,
  type CloudContainerPurpose,
  type CloudContainerStatus,
} from '../models/cloud-container.js';
import type {
  CloudContainerEntity,
  ContainerRepository,
  UpdateContainerInput,
} from '../repositories/container-repository.js';
import type { K8sJobManager } from './k8s-job-manager.js';
import { KeyedMutex } from './keyed-mutex.js';
import type { TokenService } from './token-service.js';

export class ContainerNotFoundError extends Error {
  constructor(public readonly containerId: string) {
    super(`Container not found: ${containerId}`);
    this.name = 'ContainerNotFoundError';
  }
}

export class UnsupportedPurposeError extends Error {
  constructor(message = '该任务类型暂未开放') {
    super(message);
    this.name = 'UnsupportedPurposeError';
  }
}

export class JobCreationError extends Error {
  constructor(
    public readonly containerId: string,
    reason: string,
    public readonly container: CloudContainerEntity | null,
  ) {
    super(reason);
    this.name = 'JobCreationError';
  }
}

export interface ContainerServiceConfig {
  namespace: string;
  image: string;
  connectTimeoutMs: number;
  shutdownGraceMs: number;
}

interface Logger {
  error?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/** 允许被生命周期转移覆写的状态（非终态）。 */
const ACTIVE_STATUSES: readonly CloudContainerStatus[] = ['creating', 'connecting', 'online'];

function randomSuffix(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DestroyResult {
  success: boolean;
  id: string;
  status: string;
  deletedJob: boolean;
}

/**
 * 容器生命周期状态机编排：
 * creating → connecting → online → destroying → exited（失败终态 failed）。
 *
 * 状态写回一律带状态前置条件（CAS），并对同一容器串行化 start/destroy/回收操作，
 * 避免多链路交错产生状态错乱或孤儿 Job。
 */
export class ContainerService {
  private readonly shutdownHandlers = new Set<(containerId: string) => Promise<void> | void>();
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly repo: ContainerRepository,
    private readonly tokenService: TokenService,
    private readonly jobManager: K8sJobManager,
    private readonly cfg: ContainerServiceConfig,
    private readonly logger: Logger = console,
  ) {}

  /** 注册销毁通知（由 Socket.IO 网关接入，用于向在线容器 emit shutdown）。 */
  onShutdown(handler: (containerId: string) => Promise<void> | void): () => void {
    this.shutdownHandlers.add(handler);
    return () => this.shutdownHandlers.delete(handler);
  }

  private async notifyShutdown(containerId: string): Promise<void> {
    for (const handler of this.shutdownHandlers) {
      try {
        await handler(containerId);
      } catch (err) {
        this.logger.warn?.(`shutdown handler failed for ${containerId}`, err);
      }
    }
  }

  /** 带状态前置条件的写入：条件不满足（已被并发转移/进入终态）时回读最新记录。 */
  private async updateGuarded(
    containerId: string,
    patch: UpdateContainerInput,
  ): Promise<CloudContainerEntity | null> {
    const updated = await this.repo.update(containerId, patch, {
      fromStatuses: [...ACTIVE_STATUSES],
    });
    if (updated) return updated;
    return this.repo.findById(containerId);
  }

  /**
   * 若 Job 仍存在则删除；区分「Job 不存在（absent）」与「删除失败（failed）」：
   * 卡死的 `destroying` 记录即便 Job 已不存在也需迁移 `exited`，故必须能区分二者。
   */
  private async deleteJobIfExistsDetailed(
    name: string,
  ): Promise<'deleted' | 'absent' | 'failed'> {
    let exists: boolean;
    try {
      exists = (await this.jobManager.getJob(name)) !== null;
    } catch (err) {
      this.logger.error?.(`Failed to check job ${name}`, err);
      return 'failed';
    }
    if (!exists) return 'absent';
    try {
      await this.jobManager.deleteJob(name);
      return 'deleted';
    } catch (err) {
      this.logger.error?.(`Failed to delete residual job ${name}`, err);
      return 'failed';
    }
  }

  /**
   * 启动容器：① 落库 creating → ② 签发 token → ③ 创建 Job → ④ 成功 connecting / 失败 failed。
   * 全程持有该容器的串行锁，且在 creating→connecting 时做状态前置校验：若记录已被并发
   * 销毁/置终态，则回收刚创建的 Job，避免孤儿资源。
   */
  async start(
    purpose: CloudContainerPurpose,
    refId: string | null = null,
  ): Promise<CloudContainerEntity> {
    if (purpose !== 'idle') {
      throw new UnsupportedPurposeError();
    }

    const name = `zag-worker-${randomSuffix(6)}`;
    const created = await this.repo.create({
      name,
      namespace: this.cfg.namespace,
      purpose,
      image: this.cfg.image,
      refId: refId ?? null,
      status: 'creating',
    });

    return this.mutex.runExclusive(created.id, async () => {
      const token = await this.tokenService.issue(created.id);

      try {
        await this.jobManager.createJob({
          jobName: name,
          containerId: created.id,
          token,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const failed = await this.repo.update(
          created.id,
          {
            status: 'failed',
            exitReason: `Job 创建失败: ${reason}`,
            tokenHash: null,
          },
          { fromStatuses: [...ACTIVE_STATUSES] },
        );
        throw new JobCreationError(
          created.id,
          reason,
          failed ?? (await this.repo.findById(created.id)),
        );
      }

      const connecting = await this.repo.update(
        created.id,
        { status: 'connecting' },
        { fromStatuses: ['creating'] },
      );
      if (connecting) return connecting;

      // 记录已被并发销毁或进入终态：回收刚创建的 Job，避免永久孤儿
      await this.deleteResidualJob(name);
      return (await this.repo.findById(created.id)) ?? created;
    });
  }

  private async deleteResidualJob(name: string): Promise<void> {
    try {
      await this.jobManager.deleteJob(name);
    } catch (err) {
      this.logger.error?.(`Failed to reclaim orphaned job ${name}`, err);
    }
  }

  async markConnecting(containerId: string): Promise<CloudContainerEntity | null> {
    return this.updateGuarded(containerId, { status: 'connecting' });
  }

  async markOnline(containerId: string): Promise<CloudContainerEntity | null> {
    return this.updateGuarded(containerId, {
      status: 'online',
      connectedAt: new Date(),
      exitReason: null,
    });
  }

  async markExited(
    containerId: string,
    exitReason: string,
    at: Date = new Date(),
  ): Promise<CloudContainerEntity | null> {
    return this.updateGuarded(containerId, {
      status: 'exited',
      exitedAt: at,
      exitReason,
      tokenHash: null,
    });
  }

  async markFailed(
    containerId: string,
    exitReason: string,
    at: Date = new Date(),
  ): Promise<CloudContainerEntity | null> {
    return this.updateGuarded(containerId, {
      status: 'failed',
      exitedAt: at,
      exitReason,
      tokenHash: null,
    });
  }

  async getById(containerId: string): Promise<CloudContainerEntity | null> {
    return this.repo.findById(containerId);
  }

  /**
   * 强制销毁：在线先 emit shutdown 宽限 → deleteJob → destroying → exited（清空 tokenHash）。
   * 对终态记录仍会核实 Job 是否存在并清理残留（幂等体现在响应上，`deletedJob` 反映真实动作）。
   * 全程持有该容器的串行锁，避免与 `start()` 交错产生孤儿 Job。
   */
  async destroy(containerId: string): Promise<DestroyResult> {
    const container = await this.repo.findById(containerId);
    if (!container) {
      throw new ContainerNotFoundError(containerId);
    }
    return this.mutex.runExclusive(containerId, () => this.destroyLocked(containerId));
  }

  private async destroyLocked(containerId: string): Promise<DestroyResult> {
    const container = await this.repo.findById(containerId);
    if (!container) {
      throw new ContainerNotFoundError(containerId);
    }

    // 终态记录：不跳过清理，核实并删除残留 Job（幂等语义 = Job 不存在时不再重复删除）。
    if (isTerminalStatus(container.status)) {
      const deletion = await this.deleteJobIfExistsDetailed(container.name);
      // 卡死的 destroying（销毁被 SIGTERM 打断）：Job 删除失败则保留待巡检重试；
      // 否则迁移 exited，兑现契约 `destroying → exited`（问题 50）。
      if (container.status === 'destroying') {
        if (deletion === 'failed') {
          return { success: true, id: containerId, status: 'destroying', deletedJob: false };
        }
        const exited = await this.repo.update(
          containerId,
          {
            status: 'exited',
            exitedAt: new Date(),
            exitReason:
              deletion === 'deleted' ? '强制销毁' : '强制销毁（Job 已不存在）',
            tokenHash: null,
          },
          { fromStatuses: ['destroying'] },
        );
        const current = exited ?? (await this.repo.findById(containerId));
        return {
          success: true,
          id: containerId,
          status: current?.status ?? 'exited',
          deletedJob: deletion === 'deleted',
        };
      }
      const deletedJob = deletion === 'deleted';
      if (deletedJob) {
        await this.repo.update(containerId, { tokenHash: null });
      }
      return { success: true, id: containerId, status: container.status, deletedJob };
    }

    const destroying = await this.repo.update(
      containerId,
      { status: 'destroying' },
      { fromStatuses: [...ACTIVE_STATUSES] },
    );
    if (!destroying) {
      // 并发操作已将其置为终态，按终态路径幂等清理。
      return this.destroyLocked(containerId);
    }

    if (container.status === 'online') {
      await this.notifyShutdown(containerId);
      if (this.cfg.shutdownGraceMs > 0) {
        await delay(this.cfg.shutdownGraceMs);
      }
    }

    let deletedJob = false;
    try {
      await this.jobManager.deleteJob(container.name);
      deletedJob = true;
    } catch (err) {
      this.logger.error?.(`Failed to delete job ${container.name}`, err);
    }

    // Job 删除失败时显式告警，便于运维发现残留 Job（不静默）
    const exitReason = deletedJob ? '强制销毁' : '强制销毁（Job 删除失败，需人工清理）';
    // 终态写回同样带 CAS（问题 50）：仅从 destroying 迁移，避免扩副本/并发下用陈旧状态覆写。
    const exited = await this.repo.update(
      containerId,
      {
        status: 'exited',
        exitedAt: new Date(),
        exitReason,
        tokenHash: null,
      },
      { fromStatuses: ['destroying'] },
    );
    if (!exited) {
      // CAS 未命中（已被并发转移）：回读当前状态返回，绝不用陈旧值覆写。
      const current = await this.repo.findById(containerId);
      return {
        success: true,
        id: containerId,
        status: current?.status ?? 'exited',
        deletedJob,
      };
    }

    return { success: true, id: containerId, status: 'exited', deletedJob };
  }

  /**
   * 终态回收兜底：对 `failed` / `exited` / `destroying` 记录，若仍存在关联 Job 则删除
   * （问题 50：`exited` 记录若 Job 删除曾失败也需重试回收，不再只扫 `failed`/`destroying`）。
   * 卡死的 `destroying` 记录（销毁流程被 SIGTERM 打断）在 Job 回收后按契约迁移 `exited`
   * （`destroying → exited`），避免永久停在 destroying。
   * 供周期性巡检与 reconcile 调用。
   */
  async reclaimResidualJob(containerId: string): Promise<boolean> {
    return this.mutex.runExclusive(containerId, async () => {
      const record = await this.repo.findById(containerId);
      if (!record) return false;
      if (
        record.status !== 'failed' &&
        record.status !== 'destroying' &&
        record.status !== 'exited'
      ) {
        return false;
      }

      const deletion = await this.deleteJobIfExistsDetailed(record.name);
      if (deletion === 'failed') {
        // Job 确实存在但删除失败：保留当前状态，等待下一次巡检重试（不谎报已回收）。
        return false;
      }

      if (record.status === 'destroying') {
        // 契约要求 destroying → exited：无论 Job 本次被删除还是已不存在，都迁移终态。
        await this.repo.update(
          containerId,
          {
            status: 'exited',
            exitedAt: new Date(),
            exitReason:
              deletion === 'deleted' ? '强制销毁' : '强制销毁（Job 已不存在）',
            tokenHash: null,
          },
          { fromStatuses: ['destroying'] },
        );
      } else if (deletion === 'deleted') {
        await this.repo.update(containerId, { tokenHash: null });
      }

      return deletion === 'deleted';
    });
  }

  /**
   * 列表：落库状态合并 K8s 实时状态（Job 消失/失败/成功时回写）。
   * `creating` 记录在 Job 尚未创建完成前不判定为「Job 已回收」，避免误置 failed。
   */
  async list(): Promise<CloudContainerEntity[]> {
    const records = await this.repo.findAll();
    const result: CloudContainerEntity[] = [];

    for (const record of records) {
      let effective = record;
      if (!isTerminalStatus(record.status)) {
        const job = await this.jobManager.getJob(record.name);
        if (!job) {
          if (record.status !== 'creating') {
            effective = (await this.markFailed(record.id, 'Job 已回收')) ?? record;
          }
        } else if (job.phase === 'failed') {
          effective = (await this.markFailed(record.id, job.message ?? '容器异常退出')) ?? record;
        } else if (job.phase === 'succeeded') {
          effective = (await this.markExited(record.id, '容器正常退出')) ?? record;
        }
      }
      result.push(effective);
    }

    return result;
  }
}
