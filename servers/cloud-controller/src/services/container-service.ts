import { isTerminalStatus, type CloudContainerPurpose } from '../models/cloud-container.js';
import type {
  CloudContainerEntity,
  ContainerRepository,
} from '../repositories/container-repository.js';
import type { K8sJobManager } from './k8s-job-manager.js';
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
 */
export class ContainerService {
  private readonly shutdownHandlers = new Set<(containerId: string) => Promise<void> | void>();

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

  /**
   * 启动容器：① 落库 creating → ② 签发 token → ③ 创建 Job → ④ 成功 connecting / 失败 failed。
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

    const token = await this.tokenService.issue(created.id);

    try {
      await this.jobManager.createJob({
        jobName: name,
        containerId: created.id,
        token,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const failed = await this.repo.update(created.id, {
        status: 'failed',
        exitReason: `Job 创建失败: ${reason}`,
      });
      throw new JobCreationError(created.id, reason, failed);
    }

    const connecting = await this.repo.update(created.id, { status: 'connecting' });
    return connecting ?? created;
  }

  async markConnecting(containerId: string): Promise<CloudContainerEntity | null> {
    return this.repo.update(containerId, { status: 'connecting' });
  }

  async markOnline(containerId: string): Promise<CloudContainerEntity | null> {
    return this.repo.update(containerId, {
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
    return this.repo.update(containerId, {
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
    return this.repo.update(containerId, {
      status: 'failed',
      exitedAt: at,
      exitReason,
    });
  }

  async getById(containerId: string): Promise<CloudContainerEntity | null> {
    return this.repo.findById(containerId);
  }

  /**
   * 强制销毁：在线先 emit shutdown 宽限 → deleteJob → destroying → exited（清空 tokenHash）。
   * 终态容器幂等返回成功，不重复删除 Job。
   */
  async destroy(containerId: string): Promise<DestroyResult> {
    const container = await this.repo.findById(containerId);
    if (!container) {
      throw new ContainerNotFoundError(containerId);
    }
    if (isTerminalStatus(container.status)) {
      return { success: true, id: containerId, status: container.status, deletedJob: false };
    }

    await this.repo.update(containerId, { status: 'destroying' });

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

    await this.repo.update(containerId, {
      status: 'exited',
      exitedAt: new Date(),
      exitReason: '强制销毁',
      tokenHash: null,
    });

    return { success: true, id: containerId, status: 'exited', deletedJob };
  }

  /**
   * 列表：落库状态合并 K8s 实时状态（Job 消失/失败/成功时回写）。
   */
  async list(): Promise<CloudContainerEntity[]> {
    const records = await this.repo.findAll();
    const result: CloudContainerEntity[] = [];

    for (const record of records) {
      let effective = record;
      if (!isTerminalStatus(record.status)) {
        const job = await this.jobManager.getJob(record.name);
        if (!job) {
          effective = (await this.markFailed(record.id, 'Job 已回收')) ?? record;
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
