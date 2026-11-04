/**
 * 云存储编排（契约 A.2.7 ~ A.2.9 / 提案实现点 6~9）。
 *
 * - PVC 生命周期：创建（ensure 幂等）、查询、删除、恢复前清理残留；
 * - 归档：销毁云电脑后创建 archiver Job，写 `.tmp` → 删旧 → `mv` 原子替换，
 *   完成后解析 `ZAG_ARCHIVE_RESULT` 标记行 → **先删源 PVC** → 回调 agent-api（裁决 13/14）；
 * - 恢复：启动前删除同名残留 PVC 再按原容量/StorageClass 重建（裁决 13），Job 内 initContainer 解压；
 * - 用量：du Job 固定 `nodeName`（RWO 同节点，裁决 15），只读挂载；
 * - 清理：删除源 PVC + 清理归档目录；
 * - 归档/恢复/用量/清理按工作区归档 PVC `KeyedMutex` 串行。
 */
import type { CloudContainerEntity, ContainerRepository } from '../repositories/container-repository.js';
import {
  InvalidOperationIdError,
  OperationRunningError,
  type StorageOperationEntity,
  type StorageOperationRepository,
} from '../repositories/storage-operation-repository.js';
import { type ObservationLogger } from '../observability/logger.js';
import type { AgentApiClient } from './agent-api-client.js';
import type { K8sClient, K8sContainer, K8sJobManifest, K8sVolume } from './k8s-client.js';
import { KeyedMutex } from './keyed-mutex.js';
import {
  K8sStorageManager,
  StoragePvcConflictError,
  buildArchiveFileName,
  sanitizeArchiveName,
  STORAGE_APP_LABEL,
  STORAGE_APP_VALUE,
  ARCHIVE_APP_VALUE,
  STORAGE_ID_LABEL,
} from './k8s-storage-manager.js';

export { buildArchiveFileName, sanitizeArchiveName, StoragePvcConflictError };
export { InvalidOperationIdError, OperationRunningError };

/** 容器不存在（归档触发/用量刷新）。 */
export class StorageContainerNotFoundError extends Error {
  constructor(public readonly containerId: string) {
    super(`Container not found: ${containerId}`);
    this.name = 'StorageContainerNotFoundError';
  }
}

/** 删除 PVC 时仍有活跃容器引用（契约 A.2.7 409 STORAGE_IN_USE）。 */
export class StorageInUseError extends Error {
  constructor(public readonly storageId: string) {
    super(`storage is in use: ${storageId}`);
    this.name = 'StorageInUseError';
  }
}

/** 归档进行中（409 ARCHIVE_RUNNING；幂等返回已有 archiveId）。 */
export class StorageArchiveRunningError extends Error {
  constructor(public readonly archiveId: string | null) {
    super('archive is running');
    this.name = 'StorageArchiveRunningError';
  }
}

/** 容器仍活跃（归档只在销毁后触发；409 CONTAINER_ACTIVE）。 */
export class ContainerActiveError extends Error {
  constructor(public readonly containerId: string) {
    super(`container is active: ${containerId}`);
    this.name = 'ContainerActiveError';
  }
}

/** 容器未挂载存储（409 NO_STORAGE）。 */
export class NoStorageError extends Error {
  constructor(message = 'container has no storage') {
    super(message);
    this.name = 'NoStorageError';
  }
}

/** 容器非活跃 / Pod 不存在（409 CONTAINER_NOT_ACTIVE）。 */
export class ContainerNotActiveError extends Error {
  constructor(message = 'container is not active') {
    super(message);
    this.name = 'ContainerNotActiveError';
  }
}

export const DEFAULT_ARCHIVE_ROOT = '/archive';
export const DEFAULT_SOURCE_ROOT = '/source';
export const DEFAULT_ARCHIVE_POLL_INTERVAL_MS = 5000;
export const SOURCE_PVC_DELETE_ATTEMPTS = 3;
export const ARCHIVE_RESULT_PREFIX = 'ZAG_ARCHIVE_RESULT=';
export const ARCHIVE_LABEL_ROLE = 'zag.cloud/role';
export const ARCHIVE_ID_LABEL = 'zag.cloud/archive-id';
/** 存储级操作台账单号标签（归档/复原 Job 的 Pod 选择器）。 */
export const STORAGE_OP_ID_LABEL = 'zag.cloud/storage-op-id';

export interface ArchiveCallbackPayload {
  archiveId: string;
  storageId: string;
  cloudHostId: string | null;
  containerId: string | null;
  cloudHostName: string | null;
  fileName: string;
  path: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  usageBytes: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
  /** 归档成功后源 PVC 是否已释放（删除失败时为 false，裁决 13）。 */
  sourcePvcReleased?: boolean;
  /** 存储级归档操作单号（容器级归档缺省）。 */
  operationId?: string | null;
}

export interface RestoreCallbackPayload {
  operationId: string;
  storageId: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  usageBytes: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
}

export interface UsageCallbackPayload {
  usageBytes: number;
  measuredAt: string;
}

/** `notifyStorageArchive` / `notifyStorageUsage` / `notifyStorageRestore` 的最小契约（便于单测注入桩）。 */
export type StorageCallbackClient = Pick<
  AgentApiClient,
  'notifyStorageArchive' | 'notifyStorageUsage' | 'notifyStorageRestore'
>;

export interface StorageServiceConfig {
  namespace: string;
  archiverImage: string;
  archiveTimeoutMs: number;
  /** Job 状态轮询间隔（默认 5000ms）。 */
  pollIntervalMs?: number;
  archiveRoot?: string;
  sourceRoot?: string;
}

export interface StorageServiceDeps {
  repo: ContainerRepository;
  k8sClient: K8sClient;
  storageManager: K8sStorageManager;
  /** 存储级归档/复原操作台账（可选：未配置时新端点 503）。 */
  operationRepo?: StorageOperationRepository;
  agentApiClient?: StorageCallbackClient;
  logger: ObservationLogger;
  config: StorageServiceConfig;
  /** 测试注入：sleep / 当前时间。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** 启动请求中的存储挂载参数（契约 A.2.2）。 */
export interface StartStorageInput {
  id: string;
  pvcName: string;
  sizeGi: number;
  workspaceId: string;
  storageClass?: string | null;
  restore?: { archivePath: string } | null;
}

export interface StartStoragePrepareResult {
  pvcName: string;
  created: boolean;
}

export interface CleanupStorageInput {
  storageId: string;
  workspaceId: string;
  deleteArchive: boolean;
}

/** 存储级归档请求（契约 A.2.11）。 */
export interface StorageArchiveRequestInput {
  operationId: string;
  archiveId: string;
  fileName: string;
  workspaceId: string;
  tenantId?: string | null;
}

/** 存储级复原请求（契约 A.2.12；复原到归档与 fork 共用）。 */
export interface StorageRestoreRequestInput {
  operationId: string;
  workspaceId: string;
  tenantId?: string | null;
  archivePath: string;
  sizeGi: number;
  storageClass?: string | null;
}

export interface RefreshUsageResult {
  accepted: boolean;
}

/** 解析归档/用量 Job 日志中的 `ZAG_ARCHIVE_RESULT={\"usageBytes\":N}` 标记行。 */
export function parseUsageBytes(log: string): number | null {
  const match = log.match(/ZAG_ARCHIVE_RESULT=(\{[^\n\r]*\})/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!) as { usageBytes?: unknown };
    const value = parsed.usageBytes;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return Math.floor(value);
  } catch {
    return null;
  }
}

function randomSuffix(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function jobSuffix(containerId: string): string {
  const cleaned = containerId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return `${cleaned.slice(-6) || 'unknown'}-${randomSuffix(3)}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** K8s label 值安全化（≤63、字母数字起止，非法字符替换 `-`）。 */
export function toLabelValue(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .slice(0, 63)
    .replace(/^[-_.]+|[-_.]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'x';
}

/** 归档请求队列：仅 `exited`/`failed` 允许触发归档（`destroying` 仍有 Job/写源卷）。 */
const ARCHIVABLE_CONTAINER_STATUSES = ['exited', 'failed'] as const;

function isArchivableStatus(status: string): boolean {
  return (ARCHIVABLE_CONTAINER_STATUSES as readonly string[]).includes(status);
}

function isStorageActiveStatus(status: string): boolean {
  return !isArchivableStatus(status);
}

/** 恢复前等待同名 PVC 真正消失（删除为异步，避免命中 Terminating 卷）。 */
const PVC_DELETE_WAIT_TIMEOUT_MS = 60_000;
const PVC_DELETE_POLL_INTERVAL_MS = 500;

export class StorageService {
  private readonly archiveMutex = new KeyedMutex();
  private readonly tasks = new Set<Promise<void>>();
  /** 本进程内正在执行的归档（按容器 id）；重启后为空 → 由巡检重跑。 */
  private readonly runningArchiveContainers = new Set<string>();
  /** 已成功投递回调的容器（重启后清空 → 巡检重投一次，幂等）。 */
  private readonly callbackDelivered = new Set<string>();
  /** 本进程内正在执行的存储级操作（按 operationId）；重启后为空 → 由巡检重跑。 */
  private readonly runningOperations = new Set<string>();
  /** 进行中的清理 Job（按工作区）：完成前同工作区归档/用量排队。 */
  private readonly cleanupInFlight = new Map<string, Promise<void>>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly deps: StorageServiceDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => new Date());
  }

  get storageManager(): K8sStorageManager {
    return this.deps.storageManager;
  }

  private get pollIntervalMs(): number {
    return this.deps.config.pollIntervalMs ?? DEFAULT_ARCHIVE_POLL_INTERVAL_MS;
  }

  private get archiveRoot(): string {
    return this.deps.config.archiveRoot ?? DEFAULT_ARCHIVE_ROOT;
  }

  private get sourceRoot(): string {
    return this.deps.config.sourceRoot ?? DEFAULT_SOURCE_ROOT;
  }

  archivePvcName(workspaceId: string): string {
    return this.deps.storageManager.archivePvcName(workspaceId);
  }

  archivePath(workspaceId: string, storageId: string, fileName: string): string {
    return `${this.archiveRoot}/${workspaceId}/${storageId}/${fileName}`;
  }

  // ---------------------------------------------------------------- PVC 生命周期

  async createStorage(input: {
    storageId: string;
    tenantId?: string | null;
    workspaceId?: string | null;
    sizeGi: number;
    storageClass?: string | null;
  }): Promise<{ storageId: string; pvcName: string; created: boolean }> {
    const result = await this.deps.storageManager.ensureStoragePvc(input);
    return { storageId: input.storageId, pvcName: result.pvcName, created: result.created };
  }

  async getStorage(storageId: string): Promise<{
    storageId: string;
    pvcName: string;
    exists: boolean;
    capacity: string | null;
    phase: string | null;
    storageClassName: string | null;
  }> {
    const pvcName = this.deps.storageManager.storagePvcName(storageId);
    const pvc = await this.deps.storageManager.getStoragePvc(storageId);
    return {
      storageId,
      pvcName,
      exists: pvc !== null,
      capacity: pvc?.capacity ?? null,
      phase: pvc?.phase ?? null,
      storageClassName: pvc?.storageClassName ?? null,
    };
  }

  /** 仍有活跃（非终态）容器引用该存储。 */
  async hasActiveContainer(storageId: string): Promise<boolean> {
    const records = await this.deps.repo.findAll();
    return records.some(
      (record) => record.storageId === storageId && isStorageActiveStatus(record.status),
    );
  }

  async deleteStorage(storageId: string): Promise<{ storageId: string; deleted: boolean }> {
    if (await this.hasActiveContainer(storageId)) {
      throw new StorageInUseError(storageId);
    }
    const inflight = await this.findInflightArchive(storageId);
    if (inflight) {
      throw new StorageArchiveRunningError(inflight.storageArchiveId);
    }
    const inflightOperation = await this.findInflightOperation(storageId);
    if (inflightOperation) {
      throw new OperationRunningError(storageId);
    }
    await this.deps.storageManager.deleteStoragePvc(storageId);
    return { storageId, deleted: true };
  }

  /**
   * 启动前准备（容器创建链路，容器锁内调用）：
   * - 全新挂载：ensure PVC（已存在则校验规格）；
   * - 归档恢复：**先删除同名残留 PVC**（裁决 13）再按原容量/StorageClass 重建，保证空卷。
   */
  async prepareForStart(
    input: StartStorageInput,
    tenantId?: string | null,
  ): Promise<StartStoragePrepareResult> {
    if (input.restore) {
      return this.recreateStoragePvc({
        storageId: input.id,
        tenantId: tenantId ?? null,
        workspaceId: input.workspaceId,
        sizeGi: input.sizeGi,
        storageClass: input.storageClass ?? null,
      });
    }
    return this.deps.storageManager.ensureStoragePvc({
      storageId: input.id,
      tenantId: tenantId ?? null,
      workspaceId: input.workspaceId,
      sizeGi: input.sizeGi,
      storageClass: input.storageClass ?? null,
    });
  }

  /**
   * 复原/fork 目标 PVC 准备（裁决 13 / D12）：先删同名残留（存在时）并轮询至真正消失，
   * 再按 `sizeGi`/`storageClass` ensure 重建。fork 时 PVC 尚不存在，等价于直接 ensure。
   */
  async recreateStoragePvc(input: {
    storageId: string;
    tenantId?: string | null;
    workspaceId: string;
    sizeGi: number;
    storageClass?: string | null;
  }): Promise<StartStoragePrepareResult> {
    const existing = await this.deps.storageManager.getStoragePvc(input.storageId);
    if (existing) {
      await this.deps.storageManager.deletePvcByName(existing.name);
      // 删除为异步：轮询至 PVC 真正消失，避免紧接的 ensure 命中 Terminating 同名卷。
      const deadline = Date.now() + PVC_DELETE_WAIT_TIMEOUT_MS;
      for (;;) {
        const remaining = await this.deps.storageManager.getStoragePvc(input.storageId);
        if (!remaining) break;
        if (Date.now() >= deadline) {
          throw new Error(`storage PVC ${existing.name} is still terminating`);
        }
        await this.sleep(PVC_DELETE_POLL_INTERVAL_MS);
      }
    }
    return this.deps.storageManager.ensureStoragePvc({
      storageId: input.storageId,
      tenantId: input.tenantId ?? null,
      workspaceId: input.workspaceId,
      sizeGi: input.sizeGi,
      storageClass: input.storageClass ?? null,
    });
  }

  // ---------------------------------------------------------------- 归档

  /**
   * 触发归档（幂等，契约 A.2.8）：
   * - 仅终态容器可归档（活跃 → 409 CONTAINER_ACTIVE）；
   * - 已挂载存储（无存储 → 409 NO_STORAGE）；
   * - `pending/running` → 409 ARCHIVE_RUNNING（带已有 archiveId）；
   * - CAS 到 `pending` 后**锁外**异步执行归档 Job。
   */
  async startArchive(
    containerId: string,
    input: { archiveId: string; fileName: string },
  ): Promise<{ accepted: boolean; archiveId: string }> {
    const container = await this.deps.repo.findById(containerId);
    if (!container) throw new StorageContainerNotFoundError(containerId);
    if (!container.storageId || !container.storagePvcName) throw new NoStorageError();
    if (isStorageActiveStatus(container.status)) throw new ContainerActiveError(containerId);

    const status = container.storageArchiveStatus;
    if (status === 'pending' || status === 'running') {
      throw new StorageArchiveRunningError(container.storageArchiveId);
    }

    const startedAt = this.now();
    const updated = await this.deps.repo.update(
      containerId,
      {
        storageArchiveStatus: 'pending',
        storageArchiveId: input.archiveId,
        storageArchiveFileName: input.fileName,
        storageArchiveStartedAt: startedAt,
        storageArchiveFinishedAt: null,
        storageArchiveFailure: null,
        storageArchiveUsageBytes: null,
      },
      { matchFields: { storageArchiveStatus: status } },
    );
    if (!updated) {
      const current = await this.deps.repo.findById(containerId);
      if (current?.storageArchiveStatus === 'pending' || current?.storageArchiveStatus === 'running') {
        throw new StorageArchiveRunningError(current.storageArchiveId);
      }
      throw new StorageArchiveRunningError(null);
    }

    this.spawn('archive', () => this.runArchive(containerId));
    return { accepted: true, archiveId: input.archiveId };
  }

  /**
   * 幂等触发点（裁决 12）：`storageId != null` 且 `storageArchiveStatus ∈ {null, failed}`
   * 时 CAS 到 `pending` 并异步执行。归档任务不在容器互斥锁内（不 acquire 容器锁）。
   *
   * `archiveId`/`fileName` 缺省时由当前容器信息生成（重启/终态兜底路径）。
   */
  async maybeStartArchive(
    containerId: string,
    input?: { archiveId?: string; fileName?: string },
  ): Promise<{ started: boolean; archiveId?: string }> {
    const container = await this.deps.repo.findById(containerId);
    if (!container || !container.storageId || !container.storagePvcName) {
      return { started: false };
    }
    // 显式跳过归档（destroy storageArchive:false）：巡检/终态兜底一律不再补归档（D2）。
    if (container.storageArchiveSkipped === true) return { started: false };
    // 从未就绪（创建/恢复失败）不归档：源卷可能为空或仅部分恢复，归档会覆盖可用旧归档。
    if (container.connectedAt === null) return { started: false };
    if (
      container.storageArchiveStatus !== null &&
      container.storageArchiveStatus !== 'failed'
    ) {
      return { started: false };
    }
    const archiveId = input?.archiveId ?? container.storageArchiveId ?? randomSuffix(16);
    const fileName =
      input?.fileName ??
      container.storageArchiveFileName ??
      buildArchiveFileName(
        container.hostName ?? container.hostId ?? 'cloud-host',
        this.now(),
      );
    const startedAt = this.now();

    // 先尝试 null → pending（原子首次写入），失败再尝试 failed → pending。
    let updated =
      container.storageArchiveStatus === null
        ? await this.deps.repo.update(
            containerId,
            {
              storageArchiveStatus: 'pending',
              storageArchiveId: archiveId,
              storageArchiveFileName: fileName,
              storageArchiveStartedAt: startedAt,
              storageArchiveFinishedAt: null,
              storageArchiveFailure: null,
              storageArchiveUsageBytes: null,
            },
            { requireNullFields: ['storageArchiveStatus'] },
          )
        : null;
    if (!updated && container.storageArchiveStatus === 'failed') {
      updated = await this.deps.repo.update(
        containerId,
        {
          storageArchiveStatus: 'pending',
          storageArchiveId: archiveId,
          storageArchiveFileName: fileName,
          storageArchiveStartedAt: startedAt,
          storageArchiveFinishedAt: null,
          storageArchiveFailure: null,
          storageArchiveUsageBytes: null,
        },
        { matchFields: { storageArchiveStatus: 'failed' } },
      );
    }
    if (!updated) return { started: false };

    this.spawn('archive', () => this.runArchive(containerId));
    return { started: true, archiveId };
  }

  private async runArchive(containerId: string): Promise<void> {
    if (this.runningArchiveContainers.has(containerId)) return;
    const container = await this.deps.repo.findById(containerId);
    if (!container) return;
    const workspaceId = container.storageWorkspaceId ?? 'unknown';
    this.runningArchiveContainers.add(containerId);
    try {
      await this.awaitCleanup(workspaceId);
      await this.archiveMutex.runExclusive(workspaceId, () => this.executeArchive(containerId));
    } finally {
      this.runningArchiveContainers.delete(containerId);
    }
  }

  private async executeArchive(containerId: string): Promise<void> {
    const container = await this.deps.repo.findById(containerId);
    if (!container || container.storageArchiveStatus !== 'pending') return;
    const archiveId = container.storageArchiveId;
    const fileName = container.storageArchiveFileName;
    const workspaceId = container.storageWorkspaceId;
    const storageId = container.storageId;
    if (!archiveId || !fileName || !workspaceId || !storageId || !container.storagePvcName) {
      await this.finishArchiveFailure(containerId, archiveId, '归档参数缺失', null, 'pending');
      return;
    }

    const running = await this.deps.repo.update(
      containerId,
      { storageArchiveStatus: 'running' },
      { matchFields: { storageArchiveStatus: 'pending', storageArchiveId: archiveId } },
    );
    if (!running) return;

    const startedAt = this.now();
    await this.callbackArchive({
      archiveId,
      storageId,
      cloudHostId: container.hostId,
      containerId,
      cloudHostName: container.hostName,
      fileName,
      path: this.archivePath(workspaceId, storageId, fileName),
      status: 'RUNNING',
      usageBytes: null,
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      failureReason: null,
    });

    let jobName: string | null = null;
    try {
      await this.deps.storageManager.ensureArchivePvc(workspaceId, container.tenantId);
      jobName = this.archiveJobName(containerId);
      await this.deps.k8sClient.createJob(
        this.buildArchiveJobManifest({
          jobName,
          containerId,
          archiveId,
          storagePvcName: container.storagePvcName,
          archivePvcName: this.archivePvcName(workspaceId),
          workspaceId,
          storageId,
          fileName,
        }),
      );

      const outcome = await this.waitForJob(jobName);
      if (outcome.phase !== 'succeeded') {
        await this.finishArchiveFailure(
          containerId,
          archiveId,
          outcome.message ?? '归档失败',
          jobName,
        );
        return;
      }

      const log = await this.deps.k8sClient.readPodLogs(this.archivePodSelector(containerId, archiveId));
      const usageBytes = parseUsageBytes(log);
      if (usageBytes === null) {
        // 裁决 14：Job succeeded 但标记行缺失/不可解析 → failed，**不删源 PVC、不替换旧归档**。
        await this.finishArchiveFailure(containerId, archiveId, '用量标记行缺失', jobName);
        return;
      }

      // 超时巡检可能已把状态收口为 failed：不再删除源 PVC（保守保留，交由运维清理）。
      const stillRunning = await this.deps.repo.findById(containerId);
      if (
        stillRunning?.storageArchiveStatus !== 'running' ||
        stillRunning.storageArchiveId !== archiveId
      ) {
        if (jobName) await this.deleteJobBestEffort(jobName);
        return;
      }

      // 裁决 13/19：先 CAS 成功（收口状态），再删除源 PVC；删除失败以 sourcePvcReleased=false 补偿。
      const finishedAt = this.now();
      const updated = await this.deps.repo.update(
        containerId,
        {
          storageArchiveStatus: 'succeeded',
          storageArchiveUsageBytes: usageBytes,
          storageArchiveFinishedAt: finishedAt,
          storageArchiveFailure: null,
        },
        { matchFields: { storageArchiveStatus: 'running', storageArchiveId: archiveId } },
      );
      if (!updated) return;
      const sourcePvcReleased = await this.deleteSourcePvcWithRetry(container.storagePvcName);
      const delivered = await this.callbackArchive({
        archiveId,
        storageId,
        cloudHostId: container.hostId,
        containerId,
        cloudHostName: container.hostName,
        fileName,
        path: this.archivePath(workspaceId, storageId, fileName),
        status: 'SUCCEEDED',
        usageBytes,
        startedAt: (updated.storageArchiveStartedAt ?? startedAt).toISOString(),
        finishedAt: finishedAt.toISOString(),
        failureReason: null,
        sourcePvcReleased,
      });
      if (delivered) this.callbackDelivered.add(containerId);
      this.deps.logger.info(
        {
          component: 'cloud-storage',
          event: 'archive_succeeded',
          containerId,
          archiveId,
          storageId,
          usageBytes,
          sourcePvcReleased,
        },
        'storage archive succeeded',
      );
      if (jobName) await this.deleteJobBestEffort(jobName);
    } catch (err) {
      await this.finishArchiveFailure(
        containerId,
        archiveId,
        err instanceof Error ? err.message : String(err),
        jobName,
      );
    }
  }

  private async finishArchiveFailure(
    containerId: string,
    archiveId: string | null,
    failureReason: string,
    jobName: string | null,
    fromStatus: 'pending' | 'running' = 'running',
  ): Promise<void> {
    const finishedAt = this.now();
    const updated = await this.deps.repo.update(
      containerId,
      {
        storageArchiveStatus: 'failed',
        storageArchiveFailure: failureReason,
        storageArchiveFinishedAt: finishedAt,
      },
      archiveId
        ? { matchFields: { storageArchiveStatus: fromStatus, storageArchiveId: archiveId } }
        : { matchFields: { storageArchiveStatus: fromStatus } },
    );
    if (updated) {
      const delivered = await this.callbackArchive({
        archiveId: archiveId ?? '',
        storageId: updated.storageId ?? '',
        cloudHostId: updated.hostId,
        containerId,
        cloudHostName: updated.hostName,
        fileName: updated.storageArchiveFileName ?? '',
        path:
          updated.storageWorkspaceId && updated.storageId && updated.storageArchiveFileName
            ? this.archivePath(
                updated.storageWorkspaceId,
                updated.storageId,
                updated.storageArchiveFileName,
              )
            : '',
        status: 'FAILED',
        usageBytes: null,
        startedAt: updated.storageArchiveStartedAt?.toISOString() ?? null,
        finishedAt: finishedAt.toISOString(),
        failureReason,
      });
      if (delivered) this.callbackDelivered.add(containerId);
      this.deps.logger.error(
        { component: 'cloud-storage', event: 'archive_failed', containerId, archiveId, failureReason },
        'storage archive failed',
      );
    }
    if (jobName) await this.deleteJobBestEffort(jobName);
  }

  private buildArchiveJobManifest(input: {
    jobName: string;
    containerId?: string | null;
    operationId?: string | null;
    archiveId: string;
    storagePvcName: string;
    archivePvcName: string;
    workspaceId: string;
    storageId: string;
    fileName: string;
  }): K8sJobManifest {
    const volumes: K8sVolume[] = [
      {
        name: 'source',
        persistentVolumeClaim: { claimName: input.storagePvcName, readOnly: true },
      },
      { name: 'archive', persistentVolumeClaim: { claimName: input.archivePvcName } },
    ];
    const labels: Record<string, string> = {
      [STORAGE_APP_LABEL]: ARCHIVE_APP_VALUE,
      [STORAGE_ID_LABEL]: toLabelValue(input.storageId),
      [ARCHIVE_ID_LABEL]: toLabelValue(input.archiveId),
      [ARCHIVE_LABEL_ROLE]: 'archive',
    };
    if (input.containerId) {
      labels['zag.cloud/container-id'] = input.containerId;
    }
    if (input.operationId) {
      labels[STORAGE_OP_ID_LABEL] = toLabelValue(input.operationId);
    }
    const container: K8sContainer = {
      name: 'archiver',
      image: this.deps.config.archiverImage,
      command: ['/usr/local/bin/archiver-entrypoint.sh'],
      env: [
        { name: 'MODE', value: 'archive' },
        { name: 'SOURCE_DIR', value: this.sourceRoot },
        { name: 'ARCHIVE_ROOT', value: this.archiveRoot },
        { name: 'WORKSPACE_ID', value: input.workspaceId },
        { name: 'STORAGE_ID', value: input.storageId },
        { name: 'ARCHIVE_FILE', value: input.fileName },
      ],
      resources: { limits: { cpu: '2', memory: '2Gi' } },
      volumeMounts: [
        { name: 'source', mountPath: this.sourceRoot, readOnly: true },
        { name: 'archive', mountPath: this.archiveRoot },
      ],
    };
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: input.jobName,
        namespace: this.deps.config.namespace,
        labels,
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 600,
        template: {
          // 修复：K8s 不会把 Job metadata.labels 复制给 Pod；日志/节点读取按 *Pod* 标签选择，
          // 因此 Job 与 Pod 模板必须写同一组标签（与 k8s-job-manager worker Job 一致）。
          metadata: { labels },
          spec: {
            restartPolicy: 'Never',
            automountServiceAccountToken: false,
            containers: [container],
            volumes,
          },
        },
      },
    };
  }

  private archiveJobName(containerId: string): string {
    return `zag-archive-${jobSuffix(containerId)}`;
  }

  private archivePodSelector(containerId: string, archiveId: string): string {
    return `zag.cloud/container-id=${containerId},${ARCHIVE_ID_LABEL}=${toLabelValue(archiveId)},${ARCHIVE_LABEL_ROLE}=archive`;
  }

  private usagePodSelector(containerId: string, storageId: string): string {
    return `zag.cloud/container-id=${containerId},${STORAGE_ID_LABEL}=${toLabelValue(storageId)},${ARCHIVE_LABEL_ROLE}=usage`;
  }

  private cleanupPodSelector(): string {
    return `${ARCHIVE_LABEL_ROLE}=cleanup`;
  }

  // ---------------------------------------------------------------- 存储级操作（归档/复原）

  private requireOperationRepo(): StorageOperationRepository {
    const repo = this.deps.operationRepo;
    if (!repo) throw new Error('storage operation ledger not configured');
    return repo;
  }

  /**
   * 触发存储级归档（契约 A.2.11，手动归档）：无活跃容器 + 台账幂等 + per-workspace 串行。
   * 返回既有 operationId（同 id 重投）或新建的 operationId。
   */
  async startStorageArchive(
    storageId: string,
    input: StorageArchiveRequestInput,
  ): Promise<{ accepted: boolean; operationId: string }> {
    const repo = this.requireOperationRepo();
    if (await this.hasActiveContainer(storageId)) {
      throw new StorageInUseError(storageId);
    }
    const { created, operation } = await repo.create({
      operationId: input.operationId,
      storageId,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId ?? null,
      type: 'archive',
      archiveId: input.archiveId,
      fileName: input.fileName,
      startedAt: this.now(),
    });
    if (created) {
      this.spawn('storage-archive', () => this.runStorageOperation(operation.id));
    }
    return { accepted: true, operationId: operation.id };
  }

  /**
   * 触发存储级复原（契约 A.2.12；复原到归档与 fork 共用）。
   * fork 时 `storageId` 为新存储（PVC 尚不存在时跳过删除直接重建）。
   */
  async startStorageRestore(
    storageId: string,
    input: StorageRestoreRequestInput,
  ): Promise<{ accepted: boolean; operationId: string }> {
    const repo = this.requireOperationRepo();
    if (await this.hasActiveContainer(storageId)) {
      throw new StorageInUseError(storageId);
    }
    const { created, operation } = await repo.create({
      operationId: input.operationId,
      storageId,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId ?? null,
      type: 'restore',
      archivePath: input.archivePath,
      sizeGi: input.sizeGi,
      storageClass: input.storageClass ?? null,
      startedAt: this.now(),
    });
    if (created) {
      this.spawn('storage-restore', () => this.runStorageOperation(operation.id));
    }
    return { accepted: true, operationId: operation.id };
  }

  /** 操作查询（契约 A.2.13）。 */
  async getOperation(
    storageId: string,
    operationId: string,
  ): Promise<{
    operationId: string;
    type: string;
    status: string;
    usageBytes: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    failureReason: string | null;
  } | null> {
    const repo = this.requireOperationRepo();
    const operation = await repo.findById(operationId, storageId);
    if (!operation) return null;
    return {
      operationId: operation.id,
      type: operation.type,
      status: operation.status,
      usageBytes: operation.usageBytes,
      startedAt: operation.startedAt.toISOString(),
      finishedAt: operation.finishedAt?.toISOString() ?? null,
      failureReason: operation.failureReason,
    };
  }

  private async runStorageOperation(operationId: string): Promise<void> {
    if (this.runningOperations.has(operationId)) return;
    const repo = this.requireOperationRepo();
    const operation = await repo.findById(operationId);
    if (!operation || (operation.status !== 'pending' && operation.status !== 'running')) return;
    this.runningOperations.add(operationId);
    try {
      await this.awaitCleanup(operation.workspaceId);
      await this.archiveMutex.runExclusive(operation.workspaceId, () =>
        operation.type === 'archive'
          ? this.executeStorageArchive(operationId)
          : this.executeStorageRestore(operationId),
      );
    } finally {
      this.runningOperations.delete(operationId);
    }
  }

  private async executeStorageArchive(operationId: string): Promise<void> {
    const repo = this.requireOperationRepo();
    const operation = await repo.findById(operationId);
    if (!operation || operation.status === 'succeeded' || operation.status === 'failed') return;
    const running =
      operation.status === 'pending' ? await repo.markRunning(operationId) : operation;
    if (!running) return;
    const archiveId = running.archiveId;
    const fileName = running.fileName;
    if (!archiveId || !fileName) {
      await this.finishStorageOperationFailure(operationId, '归档参数缺失', null);
      return;
    }
    const path = this.archivePath(running.workspaceId, running.storageId, fileName);
    let jobName: string | null = null;
    await this.callbackArchive({
      archiveId,
      storageId: running.storageId,
      cloudHostId: null,
      containerId: null,
      cloudHostName: null,
      fileName,
      path,
      status: 'RUNNING',
      usageBytes: null,
      startedAt: running.startedAt.toISOString(),
      finishedAt: null,
      failureReason: null,
      operationId,
    });
    try {
      await this.deps.storageManager.ensureArchivePvc(running.workspaceId, running.tenantId);
      jobName = `zag-archive-${running.storageId.slice(0, 8)}-${randomSuffix(4)}`;
      await this.deps.k8sClient.createJob(
        this.buildArchiveJobManifest({
          jobName,
          operationId,
          archiveId,
          storagePvcName: this.deps.storageManager.storagePvcName(running.storageId),
          archivePvcName: this.archivePvcName(running.workspaceId),
          workspaceId: running.workspaceId,
          storageId: running.storageId,
          fileName,
        }),
      );
      const outcome = await this.waitForJob(jobName);
      if (outcome.phase !== 'succeeded') {
        await this.finishStorageOperationFailure(
          operationId,
          outcome.message ?? '归档失败',
          jobName,
        );
        return;
      }
      const log = await this.deps.k8sClient.readPodLogs(
        this.storageOperationPodSelector(operationId, 'archive'),
      );
      const usageBytes = parseUsageBytes(log);
      if (usageBytes === null) {
        await this.finishStorageOperationFailure(operationId, '用量标记行缺失', jobName);
        return;
      }
      // 超时巡检可能已把状态收口为 failed：不再删除源 PVC（保守保留，交由运维清理）。
      const current = await repo.findById(operationId);
      if (current?.status !== 'running') {
        if (jobName) await this.deleteJobBestEffort(jobName);
        return;
      }
      const finishedAt = this.now();
      const succeeded = await repo.markSucceeded(operationId, { usageBytes, finishedAt });
      if (!succeeded) return;
      const sourcePvcReleased = await this.deleteSourcePvcWithRetry(
        this.deps.storageManager.storagePvcName(running.storageId),
      );
      const delivered = await this.callbackArchive({
        archiveId,
        storageId: running.storageId,
        cloudHostId: null,
        containerId: null,
        cloudHostName: null,
        fileName,
        path,
        status: 'SUCCEEDED',
        usageBytes,
        startedAt: running.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        failureReason: null,
        sourcePvcReleased,
        operationId,
      });
      if (delivered) await repo.markCallbackDelivered(operationId);
      this.deps.logger.info(
        {
          component: 'cloud-storage',
          event: 'storage_archive_succeeded',
          storageId: running.storageId,
          operationId,
          archiveId,
          usageBytes,
          sourcePvcReleased,
        },
        'storage-level archive succeeded',
      );
      if (jobName) await this.deleteJobBestEffort(jobName);
    } catch (err) {
      await this.finishStorageOperationFailure(
        operationId,
        err instanceof Error ? err.message : String(err),
        jobName,
      );
    }
  }

  private async executeStorageRestore(operationId: string): Promise<void> {
    const repo = this.requireOperationRepo();
    const operation = await repo.findById(operationId);
    if (!operation || operation.status === 'succeeded' || operation.status === 'failed') return;
    const running =
      operation.status === 'pending' ? await repo.markRunning(operationId) : operation;
    if (!running) return;
    if (!running.archivePath || !running.sizeGi) {
      await this.finishStorageOperationFailure(operationId, '复原参数缺失', null);
      return;
    }
    let jobName: string | null = null;
    await this.callbackRestore({
      operationId,
      storageId: running.storageId,
      status: 'RUNNING',
      usageBytes: null,
      startedAt: running.startedAt.toISOString(),
      finishedAt: null,
      failureReason: null,
    });
    try {
      await this.recreateStoragePvc({
        storageId: running.storageId,
        tenantId: running.tenantId,
        workspaceId: running.workspaceId,
        sizeGi: running.sizeGi,
        storageClass: running.storageClass,
      });
      const archivePvc = await this.deps.storageManager.getArchivePvc(running.workspaceId);
      if (!archivePvc) throw new Error('archive PVC not found');
      jobName = `zag-restore-${running.storageId.slice(0, 8)}-${randomSuffix(4)}`;
      await this.deps.k8sClient.createJob(
        this.buildRestoreJobManifest({
          jobName,
          operationId,
          storageId: running.storageId,
          archivePvcName: archivePvc.name,
          targetPvcName: this.deps.storageManager.storagePvcName(running.storageId),
          archivePath: running.archivePath,
          workspaceId: running.workspaceId,
        }),
      );
      const outcome = await this.waitForJob(jobName, '复原超时');
      if (outcome.phase !== 'succeeded') {
        await this.finishStorageOperationFailure(
          operationId,
          outcome.message ?? '复原失败',
          jobName,
        );
        return;
      }
      const log = await this.deps.k8sClient.readPodLogs(
        this.storageOperationPodSelector(operationId, 'restore'),
      );
      if (!/ZAG_RESTORE_DONE/.test(log)) {
        await this.finishStorageOperationFailure(operationId, '复原完成标记行缺失', jobName);
        return;
      }
      const finishedAt = this.now();
      const succeeded = await repo.markSucceeded(operationId, { finishedAt });
      if (!succeeded) return;
      const delivered = await this.callbackRestore({
        operationId,
        storageId: running.storageId,
        status: 'SUCCEEDED',
        usageBytes: null,
        startedAt: running.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        failureReason: null,
      });
      if (delivered) await repo.markCallbackDelivered(operationId);
      this.deps.logger.info(
        {
          component: 'cloud-storage',
          event: 'storage_restore_succeeded',
          storageId: running.storageId,
          operationId,
        },
        'storage-level restore succeeded',
      );
      if (jobName) await this.deleteJobBestEffort(jobName);
    } catch (err) {
      await this.finishStorageOperationFailure(
        operationId,
        err instanceof Error ? err.message : String(err),
        jobName,
      );
    }
  }

  private async finishStorageOperationFailure(
    operationId: string,
    failureReason: string,
    jobName: string | null,
  ): Promise<void> {
    const repo = this.requireOperationRepo();
    const finishedAt = this.now();
    const failed = await repo.markFailed(operationId, { failureReason, finishedAt });
    if (failed) {
      const delivered =
        failed.type === 'archive'
          ? await this.callbackArchive({
              archiveId: failed.archiveId ?? '',
              storageId: failed.storageId,
              cloudHostId: null,
              containerId: null,
              cloudHostName: null,
              fileName: failed.fileName ?? '',
              path:
                failed.fileName != null
                  ? this.archivePath(failed.workspaceId, failed.storageId, failed.fileName)
                  : '',
              status: 'FAILED',
              usageBytes: null,
              startedAt: failed.startedAt.toISOString(),
              finishedAt: finishedAt.toISOString(),
              failureReason,
              operationId,
            })
          : await this.callbackRestore({
              operationId,
              storageId: failed.storageId,
              status: 'FAILED',
              usageBytes: null,
              startedAt: failed.startedAt.toISOString(),
              finishedAt: finishedAt.toISOString(),
              failureReason,
            });
      if (delivered) await repo.markCallbackDelivered(operationId);
      this.deps.logger.error(
        {
          component: 'cloud-storage',
          event: 'storage_operation_failed',
          storageId: failed.storageId,
          operationId,
          type: failed.type,
          failureReason,
        },
        'storage-level operation failed',
      );
    }
    if (jobName) await this.deleteJobBestEffort(jobName);
  }

  /**
   * 存储级操作巡检（并入 status-sync 15s）：
   * - `pending/running` 超 `ARCHIVE_TIMEOUT_MS` → failed + 回调；
   * - 本进程无执行任务（重启）→ 重跑（归档源卷未删安全；复原整体删重建）；
   * - 终态未送达回调 → 重投一次（agent-api 幂等）。
   */
  async reconcileStorageOperations(
    now: number = Date.now(),
  ): Promise<{ retried: number; failed: number; recalled: number }> {
    const repo = this.deps.operationRepo;
    if (!repo) return { retried: 0, failed: 0, recalled: 0 };
    let retried = 0;
    let failed = 0;
    let recalled = 0;

    for (const operation of await repo.findStale(now, this.deps.config.archiveTimeoutMs)) {
      const updated = await repo.markFailed(operation.id, {
        failureReason: '操作超时',
        finishedAt: this.now(),
      });
      if (updated) {
        const delivered = await this.repostStorageCallback(updated);
        if (delivered) await repo.markCallbackDelivered(updated.id);
        failed += 1;
      }
    }

    for (const operation of await repo.findActive()) {
      if (this.runningOperations.has(operation.id)) continue;
      this.spawn('storage-operation', () => this.runStorageOperation(operation.id));
      retried += 1;
    }

    for (const operation of await repo.findUndelivered()) {
      const delivered = await this.repostStorageCallback(operation);
      if (delivered) {
        await repo.markCallbackDelivered(operation.id);
        recalled += 1;
      }
    }

    return { retried, failed, recalled };
  }

  private async repostStorageCallback(operation: StorageOperationEntity): Promise<boolean> {
    if (operation.type === 'archive') {
      return this.callbackArchive({
        archiveId: operation.archiveId ?? '',
        storageId: operation.storageId,
        cloudHostId: null,
        containerId: null,
        cloudHostName: null,
        fileName: operation.fileName ?? '',
        path: operation.fileName
          ? this.archivePath(operation.workspaceId, operation.storageId, operation.fileName)
          : '',
        status: operation.status === 'succeeded' ? 'SUCCEEDED' : 'FAILED',
        usageBytes: operation.usageBytes,
        startedAt: operation.startedAt.toISOString(),
        finishedAt: operation.finishedAt?.toISOString() ?? null,
        failureReason: operation.failureReason,
        sourcePvcReleased:
          operation.status === 'succeeded'
            ? await this.isSourcePvcReleased(operation.storageId)
            : undefined,
        operationId: operation.id,
      });
    }
    return this.callbackRestore({
      operationId: operation.id,
      storageId: operation.storageId,
      status: operation.status === 'succeeded' ? 'SUCCEEDED' : 'FAILED',
      usageBytes: operation.usageBytes,
      startedAt: operation.startedAt.toISOString(),
      finishedAt: operation.finishedAt?.toISOString() ?? null,
      failureReason: operation.failureReason,
    });
  }

  private storageOperationPodSelector(operationId: string, role: 'archive' | 'restore'): string {
    return `${STORAGE_OP_ID_LABEL}=${toLabelValue(operationId)},${ARCHIVE_LABEL_ROLE}=${role}`;
  }

  private async callbackRestore(payload: RestoreCallbackPayload): Promise<boolean> {
    const client = this.deps.agentApiClient;
    if (!client) return false;
    try {
      await client.notifyStorageRestore(payload.storageId, payload);
      return true;
    } catch (err) {
      this.deps.logger.error(
        {
          component: 'cloud-storage',
          event: 'restore_callback_failed',
          storageId: payload.storageId,
          operationId: payload.operationId,
          err,
        },
        'restore callback failed',
      );
      return false;
    }
  }

  private async findInflightOperation(
    storageId: string,
  ): Promise<StorageOperationEntity | null> {
    if (!this.deps.operationRepo) return null;
    return this.deps.operationRepo.findInflight(storageId);
  }

  private buildRestoreJobManifest(input: {
    jobName: string;
    operationId: string;
    storageId: string;
    archivePvcName: string;
    targetPvcName: string;
    archivePath: string;
    workspaceId: string;
  }): K8sJobManifest {
    const labels = {
      [STORAGE_APP_LABEL]: 'zag-restore',
      [STORAGE_ID_LABEL]: toLabelValue(input.storageId),
      'zag.cloud/workspace-id': toLabelValue(input.workspaceId),
      [STORAGE_OP_ID_LABEL]: toLabelValue(input.operationId),
      [ARCHIVE_LABEL_ROLE]: 'restore',
    };
    const volumes: K8sVolume[] = [
      {
        name: 'archive',
        persistentVolumeClaim: { claimName: input.archivePvcName, readOnly: true },
      },
      { name: 'target', persistentVolumeClaim: { claimName: input.targetPvcName } },
    ];
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: input.jobName,
        namespace: this.deps.config.namespace,
        labels,
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 600,
        template: {
          metadata: { labels },
          spec: {
            restartPolicy: 'Never',
            automountServiceAccountToken: false,
            containers: [
              {
                name: 'archiver',
                image: this.deps.config.archiverImage,
                command: ['/usr/local/bin/archiver-entrypoint.sh'],
                env: [
                  { name: 'MODE', value: 'restore' },
                  { name: 'RESTORE_FILE', value: input.archivePath },
                  { name: 'TARGET_DIR', value: '/target' },
                  { name: 'ARCHIVE_ROOT', value: this.archiveRoot },
                  { name: 'WORKSPACE_ID', value: input.workspaceId },
                  { name: 'STORAGE_ID', value: input.storageId },
                ],
                resources: { limits: { cpu: '2', memory: '2Gi' } },
                volumeMounts: [
                  { name: 'archive', mountPath: this.archiveRoot, readOnly: true },
                  { name: 'target', mountPath: '/target' },
                ],
              },
            ],
            volumes,
          },
        },
      },
    };
  }

  // ---------------------------------------------------------------- 恢复

  // 恢复所需的 initContainer 由 k8s-job-manager 依据 `CreateJobInput.storage.restorePath` 注入；
  // 本服务只负责「先删残留 PVC 再按原规格重建」（prepareForStart）。

  // ---------------------------------------------------------------- 用量

  /**
   * 用量刷新（契约 A.2.9 / 裁决 15）：仅 ATTACHED（非终态）容器 + 源 PVC 存在，
   * 从容器 Pod 读取 `nodeName` 后创建 du Job（只读挂载、固定节点），异步回调。
   */
  async refreshUsage(storageId: string, containerId: string): Promise<RefreshUsageResult> {
    const container = await this.deps.repo.findById(containerId);
    if (!container) throw new StorageContainerNotFoundError(containerId);
    if (container.storageId !== storageId || !container.storagePvcName) {
      throw new NoStorageError();
    }
    if (isArchivableStatus(container.status)) throw new ContainerNotActiveError();

    const pvc = await this.deps.storageManager.getStoragePvc(storageId);
    if (!pvc) throw new NoStorageError('storage PVC not found');

    const nodeName = await this.deps.k8sClient.readPodNodeName(
      `${STORAGE_APP_LABEL}=zag-worker,zag.cloud/container-id=${containerId}`,
    );
    if (!nodeName) throw new ContainerNotActiveError();

    const jobName = `zag-usage-${jobSuffix(containerId)}`;
    this.spawn('usage', () => this.runUsageJob(containerId, storageId, nodeName, jobName));
    return { accepted: true };
  }

  private async runUsageJob(
    containerId: string,
    storageId: string,
    nodeName: string,
    jobName: string,
  ): Promise<void> {
    const container = await this.deps.repo.findById(containerId);
    if (!container?.storagePvcName) return;
    const workspaceId = container.storageWorkspaceId ?? 'unknown';
    try {
      // 与归档/清理共用按工作区归档 PVC 串行锁（RWO 卷不可并发挂载写）。
      await this.awaitCleanup(workspaceId);
      await this.archiveMutex.runExclusive(workspaceId, async () => {
        await this.deps.k8sClient.createJob(
          this.buildUsageJobManifest({
            jobName,
            containerId,
            storageId,
            storagePvcName: container.storagePvcName!,
            nodeName,
          }),
        );
        const outcome = await this.waitForJob(jobName);
        if (outcome.phase !== 'succeeded') {
          // 失败/超时保留上一次值（异步语义，仅日志）。
          this.deps.logger.warn(
            { component: 'cloud-storage', event: 'usage_refresh_failed', containerId, storageId },
            'usage refresh job failed; keeping previous value',
          );
          return;
        }
        const log = await this.deps.k8sClient.readPodLogs(
          this.usagePodSelector(containerId, storageId),
        );
        const usageBytes = parseUsageBytes(log);
        if (usageBytes === null) {
          this.deps.logger.warn(
            { component: 'cloud-storage', event: 'usage_marker_missing', containerId, storageId },
            'usage marker missing; keeping previous value',
          );
          return;
        }
        await this.callbackUsage(storageId, {
          usageBytes,
          measuredAt: this.now().toISOString(),
        });
        this.deps.logger.info(
          { component: 'cloud-storage', event: 'usage_refreshed', containerId, storageId, usageBytes },
          'storage usage refreshed',
        );
      });
    } catch (err) {
      this.deps.logger.error(
        { component: 'cloud-storage', event: 'usage_refresh_failed', containerId, storageId, err },
        'usage refresh failed',
      );
    } finally {
      await this.deleteJobBestEffort(jobName);
    }
  }

  private buildUsageJobManifest(input: {
    jobName: string;
    containerId: string;
    storageId: string;
    storagePvcName: string;
    nodeName: string;
  }): K8sJobManifest {
    const labels = {
      [STORAGE_APP_LABEL]: 'zag-usage',
      [STORAGE_ID_LABEL]: toLabelValue(input.storageId),
      'zag.cloud/container-id': input.containerId,
      [ARCHIVE_LABEL_ROLE]: 'usage',
    };
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: input.jobName,
        namespace: this.deps.config.namespace,
        labels,
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 600,
        template: {
          // 修复：Pod 标签必须写在 template（Job metadata.labels 不会复制给 Pod）。
          metadata: { labels },
          spec: {
            // 裁决 15：du Job 固定容器所在节点，保证 RWO PVC 同节点可挂载。
            nodeName: input.nodeName,
            restartPolicy: 'Never',
            automountServiceAccountToken: false,
            containers: [
              {
                name: 'archiver',
                image: this.deps.config.archiverImage,
                command: ['/usr/local/bin/archiver-entrypoint.sh'],
                env: [
                  { name: 'MODE', value: 'usage' },
                  { name: 'SOURCE_DIR', value: this.sourceRoot },
                ],
                resources: { limits: { cpu: '1', memory: '512Mi' } },
                volumeMounts: [
                  { name: 'source', mountPath: this.sourceRoot, readOnly: true },
                ],
              },
            ],
            volumes: [
              {
                name: 'source',
                persistentVolumeClaim: { claimName: input.storagePvcName, readOnly: true },
              },
            ],
          },
        },
      },
    };
  }

  // ---------------------------------------------------------------- 清理

  /**
   * 销毁云存储（契约 A.2.7 cleanup）：归档进行中 → 409；
   * 删除源 PVC（404 幂等）+ 可选清理归档目录 `/archive/<workspaceId>/<storageId>/`。
   */
  async cleanup(input: CleanupStorageInput): Promise<{ accepted: boolean }> {
    const inflight = await this.findInflightArchive(input.storageId);
    if (inflight) {
      throw new StorageArchiveRunningError(inflight.storageArchiveId);
    }
    const inflightOperation = await this.findInflightOperation(input.storageId);
    if (inflightOperation) {
      throw new OperationRunningError(input.storageId);
    }
    // 与归档/恢复/用量共用按工作区归档 PVC 的串行锁（清理 Job 以 RW 挂载归档卷）。
    await this.archiveMutex.runExclusive(input.workspaceId, async () => {
      await this.deps.storageManager.deleteStoragePvc(input.storageId);
      if (input.deleteArchive) {
        const jobName = await this.spawnCleanupJob(input.workspaceId, input.storageId);
        if (jobName) this.trackCleanupJob(input.workspaceId, jobName);
      }
    });
    return { accepted: true };
  }

  /** 登记清理 Job：完成前同工作区归档/用量任务排队（避免 RWO 归档卷并发写）。 */
  private trackCleanupJob(workspaceId: string, jobName: string): void {
    const previous = this.cleanupInFlight.get(workspaceId);
    const task = (async () => {
      if (previous) await previous;
      try {
        await this.waitForJob(jobName);
      } finally {
        await this.deleteJobBestEffort(jobName);
      }
    })();
    this.cleanupInFlight.set(workspaceId, task);
    void task.finally(() => {
      if (this.cleanupInFlight.get(workspaceId) === task) {
        this.cleanupInFlight.delete(workspaceId);
      }
    });
  }

  private async awaitCleanup(workspaceId: string): Promise<void> {
    const pending = this.cleanupInFlight.get(workspaceId);
    if (pending) await pending;
  }

  private async spawnCleanupJob(workspaceId: string, storageId: string): Promise<string | null> {
    try {
      const archivePvc = await this.deps.storageManager.getArchivePvc(workspaceId);
      if (!archivePvc) return null; // 无归档卷即无目录可清
      const jobName = `zag-cleanup-${jobSuffix(storageId)}`;
      const labels = {
        [STORAGE_APP_LABEL]: 'zag-cleanup',
        [STORAGE_ID_LABEL]: toLabelValue(storageId),
        'zag.cloud/workspace-id': toLabelValue(workspaceId),
        [ARCHIVE_LABEL_ROLE]: 'cleanup',
      };
      const manifest: K8sJobManifest = {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: jobName,
          namespace: this.deps.config.namespace,
          labels,
        },
        spec: {
          backoffLimit: 0,
          ttlSecondsAfterFinished: 600,
          template: {
            // Pod 标签必须写在 template（Job metadata.labels 不会复制给 Pod）。
            metadata: { labels },
            spec: {
              restartPolicy: 'Never',
              automountServiceAccountToken: false,
              containers: [
                {
                  name: 'archiver',
                  image: this.deps.config.archiverImage,
                  command: ['/usr/local/bin/archiver-entrypoint.sh'],
                  env: [
                    { name: 'MODE', value: 'cleanup' },
                    { name: 'ARCHIVE_ROOT', value: this.archiveRoot },
                    { name: 'WORKSPACE_ID', value: workspaceId },
                    { name: 'STORAGE_ID', value: storageId },
                  ],
                  resources: { limits: { cpu: '1', memory: '512Mi' } },
                  volumeMounts: [{ name: 'archive', mountPath: this.archiveRoot }],
                },
              ],
              volumes: [
                {
                  name: 'archive',
                  persistentVolumeClaim: { claimName: archivePvc.name },
                },
              ],
            },
          },
        },
      };
      await this.deps.k8sClient.createJob(manifest);
      return jobName;
    } catch (err) {
      this.deps.logger.error(
        { component: 'cloud-storage', event: 'cleanup_job_failed', workspaceId, storageId, err },
        'cleanup job failed',
      );
      return null;
    }
  }

  // ---------------------------------------------------------------- 巡检

  /**
   * 归档巡检（status-sync 每轮调用，幂等）：
   * - 终态容器未触发归档（历史/崩溃）→ `maybeStartArchive`；
   * - `pending/running` 超过 `ARCHIVE_TIMEOUT_MS` → 标 `failed` 并回调；
   * - `pending/running` 但本进程无执行任务（重启）→ 重跑归档 Job（源 PVC 未删，安全）；
   * - `succeeded/failed` 但回调未送达（本进程记录）→ 重投回调（重启后每容器一次）。
   */
  async reconcileArchives(now: number = Date.now()): Promise<{ retried: number; failed: number; recalled: number }> {
    const records = await this.deps.repo.findAll();
    let retried = 0;
    let failed = 0;
    let recalled = 0;

    for (const record of records) {
      if (!record.storageId) continue;

      if (isArchivableStatus(record.status) && record.storageArchiveStatus === null) {
        const result = await this.maybeStartArchive(record.id);
        if (result.started) retried += 1;
        continue;
      }

      const status = record.storageArchiveStatus;
      if (status === 'pending' || status === 'running') {
        const startedAt =
          record.storageArchiveStartedAt?.getTime() ?? record.updatedAt.getTime();
        if (now - startedAt >= this.deps.config.archiveTimeoutMs) {
          if (await this.timeoutArchive(record)) failed += 1;
          continue;
        }
        if (!this.runningArchiveContainers.has(record.id)) {
          // 重启恢复：源 PVC 未删除，重跑同 archiveId 的归档 Job（原子替换保证旧归档不丢）。
          this.runningArchiveContainers.add(record.id);
          this.spawn('archive', async () => {
            try {
              await this.archiveMutex.runExclusive(record.storageWorkspaceId ?? 'unknown', () =>
                this.resumeArchive(record.id),
              );
            } finally {
              this.runningArchiveContainers.delete(record.id);
            }
          });
          retried += 1;
        }
        continue;
      }

      if (
        (status === 'succeeded' || status === 'failed') &&
        !this.callbackDelivered.has(record.id)
      ) {
        const delivered = await this.repostArchiveCallback(record);
        if (delivered) {
          this.callbackDelivered.add(record.id);
          recalled += 1;
        }
      }
    }

    return { retried, failed, recalled };
  }

  /** 重启恢复：把 `running` 重置回 `pending` 后重跑（保留 archiveId/fileName）。 */
  private async resumeArchive(containerId: string): Promise<void> {
    const container = await this.deps.repo.findById(containerId);
    if (!container) return;
    if (
      container.storageArchiveStatus !== 'pending' &&
      container.storageArchiveStatus !== 'running'
    ) {
      return;
    }
    if (container.storageArchiveStatus === 'running') {
      const reset = await this.deps.repo.update(
        containerId,
        { storageArchiveStatus: 'pending' },
        { matchFields: { storageArchiveStatus: 'running' } },
      );
      if (!reset) return;
    }
    await this.executeArchive(containerId);
  }

  private async timeoutArchive(container: CloudContainerEntity): Promise<boolean> {
    const finishedAt = this.now();
    const failureReason = '归档超时';
    const updated = await this.deps.repo.update(
      container.id,
      {
        storageArchiveStatus: 'failed',
        storageArchiveFailure: failureReason,
        storageArchiveFinishedAt: finishedAt,
      },
      { matchFields: { storageArchiveStatus: container.storageArchiveStatus } },
    );
    if (!updated) return false;
    const delivered = await this.callbackArchive({
      archiveId: updated.storageArchiveId ?? '',
      storageId: updated.storageId ?? '',
      cloudHostId: updated.hostId,
      containerId: updated.id,
      cloudHostName: updated.hostName,
      fileName: updated.storageArchiveFileName ?? '',
      path:
        updated.storageWorkspaceId && updated.storageId && updated.storageArchiveFileName
          ? this.archivePath(
              updated.storageWorkspaceId,
              updated.storageId,
              updated.storageArchiveFileName,
            )
          : '',
      status: 'FAILED',
      usageBytes: null,
      startedAt: updated.storageArchiveStartedAt?.toISOString() ?? null,
      finishedAt: finishedAt.toISOString(),
      failureReason,
    });
    if (delivered) this.callbackDelivered.add(updated.id);
    this.deps.logger.error(
      {
        component: 'cloud-storage',
        event: 'archive_failed',
        containerId: updated.id,
        archiveId: updated.storageArchiveId,
        failureReason,
      },
      'storage archive timed out',
    );
    return true;
  }

  private async repostArchiveCallback(container: CloudContainerEntity): Promise<boolean> {
    if (!container.storageId || !container.storageArchiveId) return false;
    const succeeded = container.storageArchiveStatus === 'succeeded';
    // 源 PVC 可能因删除失败而仍存在（sourcePvcReleased=false），重投时以实际存在性为准。
    const sourcePvcReleased = succeeded
      ? container.storageId
        ? await this.isSourcePvcReleased(container.storageId)
        : false
      : undefined;
    const delivered = await this.callbackArchive({
      archiveId: container.storageArchiveId,
      storageId: container.storageId,
      cloudHostId: container.hostId,
      containerId: container.id,
      cloudHostName: container.hostName,
      fileName: container.storageArchiveFileName ?? '',
      path:
        container.storageWorkspaceId && container.storageArchiveFileName
          ? this.archivePath(
              container.storageWorkspaceId,
              container.storageId,
              container.storageArchiveFileName,
            )
          : '',
      status: succeeded ? 'SUCCEEDED' : 'FAILED',
      usageBytes: container.storageArchiveUsageBytes,
      startedAt: container.storageArchiveStartedAt?.toISOString() ?? null,
      finishedAt: container.storageArchiveFinishedAt?.toISOString() ?? null,
      failureReason: container.storageArchiveFailure,
      // 重投同样上报实际释放结果（删除失败时必须为 false，不能写死 succeeded）。
      sourcePvcReleased,
    });
    return delivered;
  }

  // ---------------------------------------------------------------- 通用

  private async waitForJob(
    jobName: string,
    timeoutMessage = '归档超时',
  ): Promise<{ phase: 'succeeded' | 'failed'; message?: string }> {
    const deadline = Date.now() + this.deps.config.archiveTimeoutMs;
    // 首次检查不等 sleep，命中即时成功（测试/短任务零等待）。
    for (;;) {
      const job = await this.deps.k8sClient.getJob(jobName);
      if (!job) {
        return { phase: 'failed', message: 'Job 已回收' };
      }
      if (job.phase === 'succeeded') return { phase: 'succeeded' };
      if (job.phase === 'failed') {
        return { phase: 'failed', message: job.message ?? 'Job 失败' };
      }
      if (Date.now() >= deadline) {
        return { phase: 'failed', message: timeoutMessage };
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async deleteSourcePvcWithRetry(pvcName: string): Promise<boolean> {
    for (let attempt = 0; attempt < SOURCE_PVC_DELETE_ATTEMPTS; attempt += 1) {
      try {
        await this.deps.storageManager.deletePvcByName(pvcName);
        return true;
      } catch (err) {
        this.deps.logger.warn(
          {
            component: 'cloud-storage',
            event: 'source_pvc_delete_failed',
            pvcName,
            attempt: attempt + 1,
            err,
          },
          'source PVC delete failed, will retry',
        );
      }
    }
    return false;
  }

  private async deleteJobBestEffort(jobName: string): Promise<void> {
    try {
      await this.deps.k8sClient.deleteJob(jobName);
    } catch (err) {
      this.deps.logger.warn(
        { component: 'cloud-storage', event: 'archive_job_delete_failed', jobName, err },
        'archive job delete failed',
      );
    }
  }

  private async callbackArchive(payload: ArchiveCallbackPayload): Promise<boolean> {
    const client = this.deps.agentApiClient;
    if (!client) return false;
    try {
      await client.notifyStorageArchive(payload.storageId, payload);
      return true;
    } catch (err) {
      this.deps.logger.error(
        {
          component: 'cloud-storage',
          event: 'archive_callback_failed',
          containerId: payload.containerId,
          archiveId: payload.archiveId,
          err,
        },
        'archive callback failed',
      );
      return false;
    }
  }

  private async callbackUsage(storageId: string, payload: UsageCallbackPayload): Promise<void> {
    const client = this.deps.agentApiClient;
    if (!client) return;
    try {
      await client.notifyStorageUsage(storageId, payload);
    } catch (err) {
      this.deps.logger.error(
        { component: 'cloud-storage', event: 'usage_callback_failed', storageId, err },
        'usage callback failed',
      );
    }
  }

  private async findInflightArchive(
    storageId: string,
  ): Promise<CloudContainerEntity | null> {
    const records = await this.deps.repo.findAll();
    return (
      records.find(
        (record) =>
          record.storageId === storageId &&
          (record.storageArchiveStatus === 'pending' ||
            record.storageArchiveStatus === 'running'),
      ) ?? null
    );
  }

  /** 归档/用量/清理异步任务登记（SIGTERM 前可排空）。 */
  private spawn(label: string, task: () => Promise<void>): void {
    const promise = (async () => {
      try {
        await task();
      } catch (err) {
        this.deps.logger.error(
          { component: 'cloud-storage', event: 'storage_task_failed', label, err },
          'storage task failed',
        );
      }
    })();
    this.tasks.add(promise);
    void promise.finally(() => this.tasks.delete(promise));
  }

  /** 排空在途归档/用量任务（单测与 SIGTERM）。 */
  async drainArchiveTasks(timeoutMs = 30000): Promise<void> {
    if (this.tasks.size === 0) return;
    const pending = [...this.tasks];
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled(pending).then(() => undefined), timeout]);
  }

  /** 归档 Job 脚本（T-CC-AR1：`rm -f *.tmp` → 压缩 → du → 删旧 → mv → 标记行）。 */
  get archiveJobScript(): string {
    return buildArchiveScript();
  }

  /** 归档/用量 Pod 选择器（测试断言/对账用）。 */
  podSelector(containerId: string, archiveId: string): string {
    return this.archivePodSelector(containerId, archiveId);
  }

  usageJobSelector(containerId: string, storageId: string): string {
    return this.usagePodSelector(containerId, storageId);
  }

  cleanupSelector(): string {
    return this.cleanupPodSelector();
  }

  /** 归档文件名生成（宿主名安全化 + 时间戳）。 */
  buildFileName(hostName: string | null | undefined, at: Date = this.now()): string {
    return buildArchiveFileName(hostName, at);
  }

  /** 源 PVC 是否已释放（对账/运维）。 */
  async isSourcePvcReleased(storageId: string): Promise<boolean> {
    return (await this.deps.storageManager.getStoragePvc(storageId)) === null;
  }
}

/** 归档脚本（镜像 entrypoint MODE=archive 的口径说明；Job 实际执行镜像入口）。 */
export function buildArchiveScript(): string {
  return [
    'set -euo pipefail',
    'dir="$ARCHIVE_ROOT/$WORKSPACE_ID/$STORAGE_ID"',
    'mkdir -p "$dir"',
    'rm -f "$dir"/*.tmp',
    'tmp="$dir/$ARCHIVE_FILE.tmp"',
    'final="$dir/$ARCHIVE_FILE"',
    'if command -v pbzip2 >/dev/null 2>&1; then',
    '  tar -cf - -C "$SOURCE_DIR" . | pbzip2 -9 > "$tmp"',
    'else',
    '  tar -cf - -C "$SOURCE_DIR" . | bzip2 -9 > "$tmp"',
    'fi',
    'usage=$(du -sb "$SOURCE_DIR" | cut -f1)',
    'rm -f "$dir"/*.tar.gz2',
    'mv "$tmp" "$final"',
    'echo "ZAG_ARCHIVE_RESULT={\\"usageBytes\\":$usage}"',
  ].join('\n');
}

export { STORAGE_APP_VALUE };
