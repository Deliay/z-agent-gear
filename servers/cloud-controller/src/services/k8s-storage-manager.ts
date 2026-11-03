/**
 * 云存储 PVC 管理与命名（契约 A.2.7 / 提案实现点 2）。
 *
 * - 源卷：`zag-storage-<storageId>`（`STORAGE_PVC_PREFIX` 可配），RWO，容量 `<sizeGi>Gi`；
 * - 归档卷：`zag-archive-<workspaceId>`（`ARCHIVE_PVC_PREFIX` 可配），容量/访问模式可配，
 *   每工作区一块、全部存储共用（归档目录再按 storageId 分隔）；
 * - `storageClassName` 为空时**整段省略**（显式空串会禁用动态供给，必须避免）；
 * - 全部名称由服务端生成（不使用用户输入），避免 DNS-1123 与路径注入问题。
 */
import type { K8sClient, K8sPvcInfo, K8sPvcManifest } from './k8s-client.js';

export const STORAGE_APP_LABEL = 'app';
export const STORAGE_APP_VALUE = 'zag-storage';
export const ARCHIVE_APP_VALUE = 'zag-archive';
export const STORAGE_ID_LABEL = 'zag.cloud/storage-id';
export const STORAGE_WORKSPACE_LABEL = 'zag.cloud/workspace-id';
export const STORAGE_TENANT_LABEL = 'zag.cloud/tenant-id';

export const DEFAULT_STORAGE_PVC_PREFIX = 'zag-storage-';
export const DEFAULT_ARCHIVE_PVC_PREFIX = 'zag-archive-';
export const DEFAULT_ARCHIVE_PVC_SIZE = '100Gi';
export const DEFAULT_ARCHIVE_ACCESS_MODE = 'ReadWriteOnce';
export const DEFAULT_STORAGE_CLASS = '';

/** PVC 已存在但容量/StorageClass 与请求不一致（本期不支持扩容，禁止静默复用错误规格）。 */
export class StoragePvcConflictError extends Error {
  constructor(
    public readonly pvcName: string,
    public readonly reason: string,
  ) {
    super(`storage PVC conflict: ${pvcName} (${reason})`);
    this.name = 'StoragePvcConflictError';
  }
}

/** K8s 409 AlreadyExists 归一（不同 SDK 版本错误形状不一致）。 */
function isAlreadyExists(err: unknown): boolean {
  const candidate = err as {
    code?: number;
    statusCode?: number;
    response?: { statusCode?: number };
  };
  const code = candidate?.code ?? candidate?.statusCode ?? candidate?.response?.statusCode;
  return code === 409;
}

export interface StorageManagerConfig {
  namespace: string;
  storagePvcPrefix?: string;
  archivePvcPrefix?: string;
  storageClass?: string;
  archiveStorageClass?: string;
  archivePvcSize?: string;
  archiveAccessMode?: string;
}

export interface CreateStoragePvcInput {
  storageId: string;
  tenantId?: string | null;
  workspaceId?: string | null;
  sizeGi: number;
  /** 请求级 StorageClass 快照（裁决 4）；空则回退 `CLOUD_STORAGE_CLASS`。 */
  storageClass?: string | null;
}

export interface StoredPvc {
  pvcName: string;
  created: boolean;
}

/**
 * 归档文件名 ASCII 安全化（裁决 6）：保留 `[A-Za-z0-9._-]`，其余替换 `-`，
 * 折叠连续 `-`，去首尾 `-`，空则回退 `cloud-host`，截断 64 字符。
 * 额外折叠连续 `.` 并去除首尾 `.`，保证生成路径不含 `..`（恢复路径正则禁止）。
 */
export function sanitizeArchiveName(hostName: string | null | undefined): string {
  const raw = (hostName ?? '').trim();
  let safe = raw
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (safe.includes('..')) {
    safe = safe.replace(/\.{2,}/g, '.');
  }
  if (safe.length === 0) safe = 'cloud-host';
  return safe.slice(0, 64);
}

/** 归档文件名：`<safe>-<YYYYMMDD-HHmmss>.tar.gz2`（每次归档时间戳不同，故「删旧 + 改名」两步）。 */
export function buildArchiveFileName(hostName: string | null | undefined, at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  return `${sanitizeArchiveName(hostName)}-${stamp}.tar.gz2`;
}

/** 未指定/空串统一归一为 `null`（= 使用集群默认 StorageClass）。 */
function normalizeStorageClass(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class K8sStorageManager {
  private readonly storagePvcPrefix: string;
  private readonly archivePvcPrefix: string;
  private readonly storageClass: string;
  private readonly archiveStorageClass: string;
  private readonly archivePvcSize: string;
  private readonly archiveAccessMode: string;

  constructor(
    private readonly client: K8sClient,
    private readonly cfg: StorageManagerConfig,
  ) {
    this.storagePvcPrefix = cfg.storagePvcPrefix ?? DEFAULT_STORAGE_PVC_PREFIX;
    this.archivePvcPrefix = cfg.archivePvcPrefix ?? DEFAULT_ARCHIVE_PVC_PREFIX;
    this.storageClass = (cfg.storageClass ?? DEFAULT_STORAGE_CLASS).trim();
    this.archiveStorageClass = (cfg.archiveStorageClass ?? '').trim();
    this.archivePvcSize = (cfg.archivePvcSize ?? DEFAULT_ARCHIVE_PVC_SIZE).trim();
    this.archiveAccessMode = (cfg.archiveAccessMode ?? DEFAULT_ARCHIVE_ACCESS_MODE).trim();
  }

  storagePvcName(storageId: string): string {
    return `${this.storagePvcPrefix}${storageId}`;
  }

  archivePvcName(workspaceId: string): string {
    return `${this.archivePvcPrefix}${workspaceId}`;
  }

  /** 源卷 manifest（T-CC-P1）。 */
  buildStoragePvcManifest(input: CreateStoragePvcInput): K8sPvcManifest {
    const pvcName = this.storagePvcName(input.storageId);
    const labels: Record<string, string> = {
      [STORAGE_APP_LABEL]: STORAGE_APP_VALUE,
      [STORAGE_ID_LABEL]: input.storageId,
    };
    if (input.workspaceId) labels[STORAGE_WORKSPACE_LABEL] = input.workspaceId;
    if (input.tenantId) labels[STORAGE_TENANT_LABEL] = input.tenantId;

    const manifest: K8sPvcManifest = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: pvcName,
        namespace: this.cfg.namespace,
        labels,
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        volumeMode: 'Filesystem',
        resources: { requests: { storage: `${input.sizeGi}Gi` } },
      },
    };
    const storageClass = (input.storageClass ?? '').trim() || this.storageClass;
    // 空则整段省略（使用集群默认 StorageClass）。
    if (storageClass) manifest.spec.storageClassName = storageClass;
    return manifest;
  }

  /** 归档卷 manifest：每工作区一块，容量/访问模式/StorageClass 可配。 */
  buildArchivePvcManifest(workspaceId: string, tenantId?: string | null): K8sPvcManifest {
    const labels: Record<string, string> = {
      [STORAGE_APP_LABEL]: ARCHIVE_APP_VALUE,
      [STORAGE_WORKSPACE_LABEL]: workspaceId,
    };
    if (tenantId) labels[STORAGE_TENANT_LABEL] = tenantId;
    const manifest: K8sPvcManifest = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: this.archivePvcName(workspaceId),
        namespace: this.cfg.namespace,
        labels,
      },
      spec: {
        accessModes: this.archiveAccessMode
          .split(',')
          .map((mode) => mode.trim())
          .filter((mode) => mode.length > 0),
        volumeMode: 'Filesystem',
        resources: { requests: { storage: this.archivePvcSize } },
      },
    };
    if (this.archiveStorageClass) manifest.spec.storageClassName = this.archiveStorageClass;
    return manifest;
  }

  /**
   * 幂等 ensure（T-CC-P2）：
   * - 不存在 → 创建，`created:true`；
   * - 已存在且容量/StorageClass 一致 → `created:false`；
   * - 已存在但规格不同 → `StoragePvcConflictError`（409 STORAGE_PVC_CONFLICT）。
   */
  async ensureStoragePvc(input: CreateStoragePvcInput): Promise<StoredPvc> {
    const manifest = this.buildStoragePvcManifest(input);
    return this.ensureManifest(manifest, `${input.sizeGi}Gi`);
  }

  async ensureArchivePvc(workspaceId: string, tenantId?: string | null): Promise<StoredPvc> {
    const manifest = this.buildArchivePvcManifest(workspaceId, tenantId);
    return this.ensureManifest(manifest, this.archivePvcSize);
  }

  private async ensureManifest(manifest: K8sPvcManifest, capacity: string): Promise<StoredPvc> {
    const pvcName = manifest.metadata.name;
    const existing = await this.client.getPersistentVolumeClaim(pvcName);
    if (existing) return this.assertCompatible(existing, manifest, capacity);

    try {
      await this.client.createPersistentVolumeClaim(manifest);
      return { pvcName, created: true };
    } catch (err) {
      // 并发 ensure：另一请求已创建同名 PVC → 回读比对规格（幂等/冲突语义与串行一致）。
      if (isAlreadyExists(err)) {
        const raced = await this.client.getPersistentVolumeClaim(pvcName);
        if (raced) return this.assertCompatible(raced, manifest, capacity);
      }
      throw err;
    }
  }

  private assertCompatible(
    existing: K8sPvcInfo,
    manifest: K8sPvcManifest,
    capacity: string,
  ): StoredPvc {
    const pvcName = manifest.metadata.name;
    const desiredClass = normalizeStorageClass(manifest.spec.storageClassName);
    const existingCapacity = existing.capacity ?? null;
    const existingClass = normalizeStorageClass(existing.storageClassName);
    if (existingCapacity !== null && existingCapacity !== capacity) {
      throw new StoragePvcConflictError(pvcName, `capacity ${existingCapacity} != ${capacity}`);
    }
    // 未指定 StorageClass（desired=null）= 使用集群默认：K8s 回读可能是默认类名或空串，
    // 均视为兼容；仅当请求显式指定 class 时才要求精确一致（避免重试返回 409）。
    if (desiredClass !== null && existingClass !== desiredClass) {
      throw new StoragePvcConflictError(
        pvcName,
        `storageClass ${existingClass ?? '<default>'} != ${desiredClass ?? '<default>'}`,
      );
    }
    return { pvcName, created: false };
  }

  async getStoragePvc(storageId: string): Promise<K8sPvcInfo | null> {
    return this.client.getPersistentVolumeClaim(this.storagePvcName(storageId));
  }

  /** 删除源卷；404 视为成功（幂等）。 */
  async deleteStoragePvc(storageId: string): Promise<void> {
    await this.client.deletePersistentVolumeClaim(this.storagePvcName(storageId));
  }

  /** 按名称删除（恢复前清理残留同名 PVC）；404 视为成功。 */
  async deletePvcByName(pvcName: string): Promise<void> {
    await this.client.deletePersistentVolumeClaim(pvcName);
  }

  async getArchivePvc(workspaceId: string): Promise<K8sPvcInfo | null> {
    return this.client.getPersistentVolumeClaim(this.archivePvcName(workspaceId));
  }
}
