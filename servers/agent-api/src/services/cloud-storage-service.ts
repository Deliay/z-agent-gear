import mongoose from 'mongoose';
import { GraphQLError } from 'graphql';
import { config } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';
import {
  CloudStorage,
} from '../models/cloud-storage.js';
import { CloudHost } from '../models/cloud-host.js';
import { CloudContainer } from '../models/cloud-container.js';
import { User } from '../models/user.js';
import {
  CloudControllerClient,
  CloudControllerRequestError,
  cloudControllerClient,
} from './cloud-controller-client.js';
import {
  BillingClient,
  InsufficientBalanceError,
  billingClient,
} from './billing-client.js';
import {
  assertWorkspaceWritable,
  getWorkspaceContext,
  type WorkspaceContext,
} from './workspace-context.js';

const logger = rootLogger.child({ component: 'cloud-storage' });

export const CLOUD_STORAGE_NAME_MAX = 64;
export const CLOUD_STORAGE_SIZE_MIN_GI = 1;
export const CLOUD_STORAGE_SIZE_MAX_GI = 30;
export const CLOUD_STORAGE_ARCHIVE_SPACE_CAPACITY_GI = 100;
/** 归档状态超过该时长视为可对账（与提案 §9.5「ARCHIVING 超 10 分钟对账」一致）。 */
export const ARCHIVING_RECONCILE_AFTER_MS = 10 * 60 * 1000;

export type ArchiveStatusWire = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface ArchiveCallbackInput {
  archiveId: string;
  storageId?: string;
  cloudHostId?: string | null;
  containerId?: string | null;
  cloudHostName?: string | null;
  fileName?: string | null;
  path?: string | null;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  usageBytes?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  failureReason?: string | null;
  /** 仅 SUCCEEDED 有意义：源 PVC 是否已释放（false 时记入 currentArchive 留痕）。 */
  sourcePvcReleased?: boolean | null;
}

export interface UsageCallbackInput {
  usageBytes: number;
  measuredAt?: string | null;
}

export interface AttachStorageInput {
  storageId: string;
  cloudHostId: string;
  userId: string;
  controllerId?: string | null;
}

type Doc = Record<string, unknown>;

interface CloudStorageServiceDeps {
  controllerClient?: CloudControllerClient;
  billing?: BillingClient;
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function str(value: unknown): string | null {
  return value === undefined || value === null || value === '' ? null : String(value);
}

/**
 * 归档名安全化（计划期裁决 6）：
 * 保留 `[A-Za-z0-9._-]`，其余字符替换为 `-`，连续 `-` 折叠，去首尾 `-`，
 * 空则回退 `cloud-host`，截断 64 字符。
 */
export function sanitizeArchiveName(hostName: string): string {
  const safe = String(hostName ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return safe || 'cloud-host';
}

/** `YYYYMMDD-HHmmss`（UTC，文件名稳定可校验）。 */
export function archiveTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

export function buildArchiveFileName(hostName: string, date = new Date()): string {
  return `${sanitizeArchiveName(hostName)}-${archiveTimestamp(date)}.tar.gz2`;
}

function archivePath(workspaceId: string, storageId: string, fileName: string): string {
  return `/archive/${workspaceId}/${storageId}/${fileName}`;
}

export function assertStorageName(name: string): string {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('storage name is required');
  if (trimmed.length > CLOUD_STORAGE_NAME_MAX) throw new Error('storage name is too long');
  return trimmed;
}

export function assertStorageSize(sizeGi: unknown): number {
  const size = typeof sizeGi === 'number' ? sizeGi : Number(sizeGi);
  if (
    !Number.isInteger(size) ||
    size < CLOUD_STORAGE_SIZE_MIN_GI ||
    size > CLOUD_STORAGE_SIZE_MAX_GI
  ) {
    throw new Error('storage size must be between 1 and 30 Gi');
  }
  return size;
}

export function isArchiveTerminal(status: unknown): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED';
}

/**
 * 工作区级云存储领域服务：状态机（全部 CAS）、创建/销毁/重试归档/用量刷新、
 * 云电脑挂载占用与回滚、归档/用量回调。
 *
 * 写方单一：本服务是 `cloudstorages` 的唯一写方；cloud-controller 只读
 * `cloudcontainers`，agent-api 只读该镜像。
 */
export class CloudStorageService {
  private readonly controllerClient: CloudControllerClient;
  private readonly billing: BillingClient;

  constructor(deps: CloudStorageServiceDeps = {}) {
    this.controllerClient = deps.controllerClient ?? cloudControllerClient;
    this.billing = deps.billing ?? billingClient;
  }

  isEnabled(): boolean {
    // 单测/旧配置缺失字段时视为开启（生产由 env 显式控制）
    return config.cloudStorageEnabled !== false;
  }

  getCapabilities(): { enabled: boolean } {
    return { enabled: this.isEnabled() };
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) throw new Error('storage feature is disabled');
  }

  private requireContext(): WorkspaceContext {
    const context = getWorkspaceContext();
    if (!context) throw new Error('workspace not found');
    return context;
  }

  private async resolveAccount(
    tenantId: string,
  ): Promise<{ id: string | null; availableBalance: number | null }> {
    try {
      const account = await this.billing.getAccount('tenant', tenantId);
      return { id: account.id, availableBalance: account.availableBalance };
    } catch (err) {
      // 提案 §1.3 / 实现点 12：计费服务不可用时降级放行（与云电脑创建报价同口径），
      // 不阻断存储创建/挂载；billingAccountId 置空，出账由 admin-api 侧后续补记。
      logger.warn(
        { event: 'storage_billing_unavailable', tenantId, err },
        'billing unavailable, storage continues without account',
      );
      return { id: null, availableBalance: null };
    }
  }

  /** 首小时余额校验（计费服务不可用时降级放行，与云电脑报价同口径）。 */
  private async assertCanAfford(
    account: { id: string | null; availableBalance: number | null },
    sizeGi: number,
  ): Promise<void> {
    if (account.availableBalance === null) return;
    let hourlyCredits: number;
    try {
      const quote = await this.billing.getStorageQuote(sizeGi);
      hourlyCredits = quote.full.hourlyCredits;
    } catch {
      // 计费报价不可用：按默认阶梯度量，不阻断业务
      hourlyCredits = fallbackStorageQuote(sizeGi).full.hourlyCredits;
      logger.warn(
        { event: 'storage_quote_fallback', sizeGi },
        'storage quote unavailable, fallback to default tiers',
      );
    }
    if (account.availableBalance < hourlyCredits) {
      throw new InsufficientBalanceError(account.availableBalance);
    }
  }

  async create(
    userId: string,
    input: { name: string; sizeGi: number },
  ): Promise<Doc> {
    this.assertEnabled();
    const context = this.requireContext();
    assertWorkspaceWritable(context);
    const name = assertStorageName(input.name);
    const sizeGi = assertStorageSize(input.sizeGi);
    const nameKey = name.toLocaleLowerCase();

    const existing = (await CloudStorage.findOne({
      resourceWorkspaceId: context.id,
      nameKey,
      destroyedAt: null,
    })
      .select('_id')
      .lean()) as Doc | null;
    if (existing) throw new Error('storage name already exists');

    const account = await this.resolveAccount(context.tenantId);
    await this.assertCanAfford(account, sizeGi);

    const storageId = new mongoose.Types.ObjectId();
    const pvcName = `zag-storage-${String(storageId)}`;
    try {
      await CloudStorage.create({
        _id: storageId,
        name,
        nameKey,
        sizeGi,
        status: 'CREATING',
        tenantId: context.tenantId,
        resourceWorkspaceId: context.id,
        createdBy: userId,
        pvcName,
        storageClass: null,
        billingAccountId: account.id,
        billingRate: 'FULL',
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new Error('storage name already exists');
      }
      throw err;
    }

    let doc: Doc | null = null;
    try {
      const created = await this.controllerClient.createStorage({
        storageId: String(storageId),
        tenantId: context.tenantId,
        workspaceId: context.id,
        sizeGi,
      });
      const updated = (await CloudStorage.findOneAndUpdate(
        { _id: storageId, status: 'CREATING' },
        {
          $set: {
            status: 'IDLE',
            pvcName: created.pvcName || pvcName,
            billingStartedAt: new Date(),
            billingRate: 'FULL',
            billingAccountId: account.id,
          },
        },
        { returnDocument: 'after' },
      ).lean()) as Doc | null;
      doc = updated ?? ((await CloudStorage.findById(storageId).lean()) as Doc | null);
      if (!doc) throw new Error('storage not found');
    } catch (err) {
      const failureReason = err instanceof Error ? err.message : String(err);
      await CloudStorage.findOneAndUpdate(
        { _id: storageId, status: 'CREATING' },
        {
          $set: {
            status: 'CREATE_FAILED',
            failureReason,
            destroyedAt: new Date(),
          },
        },
      ).catch(() => undefined);
      // 兜底回收可能已创建的 PVC（防止 CREATE_FAILED 留下孤儿卷；best-effort）。
      const cleanup = this.controllerClient.deleteStorage?.(String(storageId));
      if (cleanup) {
        await cleanup.catch((cleanupErr) => {
          logger.warn(
            { event: 'storage_create_cleanup_failed', storageId: String(storageId), err: cleanupErr },
            'cloud storage create cleanup failed',
          );
        });
      }
      logger.warn(
        { event: 'storage_create_failed', storageId: String(storageId), err },
        'cloud storage create failed',
      );
      if (err instanceof InsufficientBalanceError) throw new Error('insufficient balance');
      throw new Error('control plane unavailable');
    }
    if (!doc) throw new Error('storage not found');
    logger.info(
      { event: 'storage_created', storageId: String(storageId), sizeGi },
      'cloud storage created',
    );
    return this.present(doc);
  }

  async list(options: { onlyAttachable?: boolean; includeDestroyed?: boolean } = {}): Promise<Doc[]> {
    const filter: Record<string, unknown> = {};
    if (!options.includeDestroyed) filter.destroyedAt = null;
    if (options.onlyAttachable) filter.status = { $in: ['IDLE', 'ARCHIVED'] };
    const docs = (await CloudStorage.find(filter).sort({ createdAt: -1 }).lean()) as Doc[];
    return this.presentMany(docs);
  }

  async get(id: string): Promise<Doc | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = (await CloudStorage.findOne({ _id: id }).lean()) as Doc | null;
    return doc ? this.present(doc) : null;
  }

  /** 云电脑 `CloudHost.storage` 摘要（按当前工作区可见集查询，缺失返回 null）。 */
  async getSummary(storageId: string): Promise<Doc | null> {
    if (!mongoose.isValidObjectId(storageId)) return null;
    const doc = (await CloudStorage.findOne({ _id: storageId })
      .select('name sizeGi status usageBytes currentArchive')
      .lean()) as Doc | null;
    if (!doc) return null;
    return {
      id: String(doc._id),
      name: String(doc.name),
      sizeGi: Number(doc.sizeGi),
      status: doc.status,
      usageBytes: doc.usageBytes ?? null,
      // 仅用于 storageRestoring 字段级判定（不属于 CloudStorageSummary 契约字段）
      currentArchive: doc.currentArchive ?? null,
    };
  }

  async destroy(id: string, userId: string): Promise<Doc> {
    const context = this.requireContext();
    assertWorkspaceWritable(context);
    if (!mongoose.isValidObjectId(id)) throw new Error('storage not found');
    const doc = (await CloudStorage.findOne({ _id: id }).lean()) as Doc | null;
    if (!doc) throw new Error('storage not found');
    if (String(doc.createdBy) !== userId && context.role !== 'admin') {
      throw new Error('not allowed to destroy storage');
    }

    const status = String(doc.status);
    const currentArchive = doc.currentArchive as Doc | null;
    const archivingFailed =
      status === 'ARCHIVING' && String(currentArchive?.status ?? '') === 'FAILED';
    if (status === 'ATTACHED') throw new Error('storage is attached');
    if (status === 'ARCHIVING' && !archivingFailed) throw new Error('storage is archiving');
    if (!['IDLE', 'ARCHIVED'].includes(status) && !archivingFailed) {
      throw new Error('storage is not destroyable');
    }

    const filter: Record<string, unknown> = archivingFailed
      ? { _id: id, status: 'ARCHIVING', 'currentArchive.status': 'FAILED' }
      : { _id: id, status };
    const moved = (await CloudStorage.findOneAndUpdate(
      filter,
      { $set: { status: 'DESTROYING' } },
      { returnDocument: 'after' },
    ).lean()) as Doc | null;
    if (!moved) throw new Error('storage is not destroyable');

    try {
      await this.controllerClient.cleanupStorage(id, {
        workspaceId: String(doc.resourceWorkspaceId),
        deleteArchive: true,
      });
    } catch (err) {
      // 清理失败回滚状态，允许重试；归档进行中仍收敛为可读文案
      await CloudStorage.updateOne(
        { _id: id, status: 'DESTROYING' },
        { $set: { status } },
      ).catch(() => undefined);
      if (err instanceof CloudControllerRequestError && err.code === 'ARCHIVE_RUNNING') {
        throw new Error('storage is archiving');
      }
      throw new Error('control plane unavailable');
    }

    const destroyed = (await CloudStorage.findOneAndUpdate(
      { _id: id, status: 'DESTROYING' },
      {
        $set: {
          status: 'DESTROYED',
          destroyedAt: new Date(),
          destroyReason: 'user request',
          attachedCloudHostId: null,
          attachedControllerId: null,
          attachedBy: null,
          attachedAt: null,
          attachFromStatus: null,
        },
      },
      { returnDocument: 'after' },
    ).lean()) as Doc | null;
    const current =
      destroyed ?? ((await CloudStorage.findById(id).lean()) as Doc | null);
    if (!current) throw new Error('storage not found');
    logger.info({ event: 'storage_destroyed', storageId: id }, 'cloud storage destroyed');
    return this.present(current);
  }

  async retryArchive(id: string, userId: string): Promise<Doc> {
    const context = this.requireContext();
    assertWorkspaceWritable(context);
    if (!mongoose.isValidObjectId(id)) throw new Error('storage not found');
    const doc = (await CloudStorage.findOne({ _id: id }).lean()) as Doc | null;
    if (!doc) throw new Error('storage not found');
    if (String(doc.createdBy) !== userId && context.role !== 'admin') {
      throw new Error('not allowed to destroy storage');
    }
    const archive = doc.currentArchive as Doc | null;
    const containerId = str(doc.lastContainerId);
    if (
      String(doc.status) !== 'ARCHIVING' ||
      !containerId ||
      !archive ||
      String(archive.status) !== 'FAILED'
    ) {
      throw new Error('no archive to retry');
    }

    const archiveId = new mongoose.Types.ObjectId().toString();
    const cloudHostName = str(archive.cloudHostName) ?? 'cloud-host';
    const fileName = buildArchiveFileName(cloudHostName);
    const path = archivePath(String(doc.resourceWorkspaceId), id, fileName);
    try {
      await this.controllerClient.triggerArchive(containerId, { archiveId, fileName });
    } catch (err) {
      if (err instanceof CloudControllerRequestError) {
        if (err.code === 'ARCHIVE_RUNNING') throw new Error('storage is archiving');
        if (err.code === 'NO_STORAGE' || err.code === 'NOT_FOUND') {
          throw new Error('no archive to retry');
        }
      }
      throw new Error('control plane unavailable');
    }

    const pending = {
      archiveId,
      containerId,
      cloudHostId: doc.attachedCloudHostId ?? archive.cloudHostId ?? null,
      cloudHostName,
      fileName,
      path,
      status: 'PENDING' as const,
      usageBytes: null,
      startedAt: new Date(),
      finishedAt: null,
      failureReason: null,
    };
    const updated = (await CloudStorage.findOneAndUpdate(
      { _id: id, status: 'ARCHIVING' },
      { $set: { currentArchive: pending } },
      { returnDocument: 'after' },
    ).lean()) as Doc | null;
    const current =
      updated ?? ((await CloudStorage.findById(id).lean()) as Doc | null);
    if (!current) throw new Error('storage not found');
    logger.info(
      { event: 'archive_retry', storageId: id, archiveId },
      'cloud storage archive retried',
    );
    return this.present(current);
  }

  async refreshUsage(id: string): Promise<Doc> {
    const context = this.requireContext();
    assertWorkspaceWritable(context);
    if (!mongoose.isValidObjectId(id)) throw new Error('storage not found');
    const doc = (await CloudStorage.findOne({ _id: id }).lean()) as Doc | null;
    if (!doc) throw new Error('storage not found');
    if (String(doc.status) !== 'ATTACHED') throw new Error('storage is not attached');

    let containerId = str(doc.lastContainerId);
    if (!containerId && doc.attachedCloudHostId) {
      const container = (await CloudContainer.findOne({
        hostId: String(doc.attachedCloudHostId),
      })
        .sort({ createdAt: -1 })
        .lean()) as Doc | null;
      containerId = container ? String(container._id) : null;
    }
    if (!containerId) throw new Error('storage is not attached');
    try {
      await this.controllerClient.refreshUsage(id, { containerId });
    } catch (err) {
      if (err instanceof CloudControllerRequestError) {
        if (err.code === 'CONTAINER_NOT_ACTIVE' || err.code === 'NO_STORAGE') {
          throw new Error('storage is not attached');
        }
      }
      throw new Error('control plane unavailable');
    }
    logger.info(
      { event: 'usage_refreshed', storageId: id, containerId },
      'cloud storage usage refresh requested',
    );
    return this.present(doc);
  }

  /**
   * 校验并占用存储（`IDLE`/`ARCHIVED → ATTACHING`）。
   * 返回挂载前状态与容器启动所需快照；失败抛 `storage is not attachable`。
   */
  async attachStorage(input: AttachStorageInput): Promise<{
    storage: Doc;
    fromStatus: 'IDLE' | 'ARCHIVED';
  }> {
    this.assertEnabled();
    const context = this.requireContext();
    assertWorkspaceWritable(context);
    if (!mongoose.isValidObjectId(input.storageId)) throw new Error('storage not found');
    const doc = (await CloudStorage.findOne({
      _id: input.storageId,
      destroyedAt: null,
    }).lean()) as Doc | null;
    if (!doc) throw new Error('storage not found');
    const status = String(doc.status);
    if (status !== 'IDLE' && status !== 'ARCHIVED') {
      throw new Error('storage is not attachable');
    }
    assertStorageSize(doc.sizeGi);

    const account = await this.resolveAccount(context.tenantId);
    await this.assertCanAfford(account, Number(doc.sizeGi));

    const fromStatus = status as 'IDLE' | 'ARCHIVED';
    const updated = (await CloudStorage.findOneAndUpdate(
      { _id: input.storageId, status: fromStatus, destroyedAt: null },
      {
        $set: {
          status: 'ATTACHING',
          attachedCloudHostId: input.cloudHostId,
          attachedControllerId: input.controllerId ?? null,
          attachedBy: input.userId,
          attachedAt: new Date(),
          attachFromStatus: fromStatus,
          // 挂载期间（含从 ARCHIVED 恢复）按全价计费；归档成功后回调再切回 HALF。
          billingRate: 'FULL',
        },
      },
      { returnDocument: 'after' },
    ).lean()) as Doc | null;
    if (!updated) throw new Error('storage is not attachable');
    logger.info(
      {
        event: 'storage_attached',
        storageId: input.storageId,
        cloudHostId: input.cloudHostId,
        fromStatus,
      },
      'cloud storage reserved for host',
    );
    return { storage: updated, fromStatus };
  }

  /** 创建成功 / ready 幂等兜底：`ATTACHING → ATTACHED`。 */
  async markAttached(storageId: string, cloudHostId?: string | null): Promise<Doc | null> {
    if (!mongoose.isValidObjectId(storageId)) return null;
    const filter: Record<string, unknown> = { _id: storageId, status: 'ATTACHING' };
    if (cloudHostId) filter.attachedCloudHostId = cloudHostId;
    const updated = (await CloudStorage.findOneAndUpdate(
      filter,
      { $set: { status: 'ATTACHED', billingRate: 'FULL' } },
      { returnDocument: 'after' },
    ).lean()) as Doc | null;
    if (updated) {
      logger.info({ event: 'storage_attached_confirmed', storageId }, 'cloud storage attached');
      return updated;
    }
    return (await CloudStorage.findOne({ _id: storageId }).lean()) as Doc | null;
  }

  /**
   * 释放存储（创建失败回滚 / 未 ready 终止）：回到 `attachFromStatus`（IDLE/ARCHIVED），
   * 清空 attached*，归档不丢。
   */
  async releaseStorage(storageId: string, cloudHostId: string): Promise<Doc | null> {
    if (!mongoose.isValidObjectId(storageId) || !mongoose.isValidObjectId(cloudHostId)) return null;
    const doc = (await CloudStorage.findOne({
      _id: storageId,
      attachedCloudHostId: cloudHostId,
    }).lean()) as Doc | null;
    if (!doc) return null;
    const fromStatus = str(doc.attachFromStatus);
    if (fromStatus !== 'IDLE' && fromStatus !== 'ARCHIVED') return null;
    const updated = (await CloudStorage.findOneAndUpdate(
      {
        _id: storageId,
        status: String(doc.status),
        attachedCloudHostId: cloudHostId,
      } as never,
      {
        $set: {
          status: fromStatus,
          // 回滚到 ARCHIVED 时恢复半价；回到 IDLE 保持全价。
          billingRate: fromStatus === 'ARCHIVED' ? 'HALF' : 'FULL',
          attachedCloudHostId: null,
          attachedControllerId: null,
          attachedBy: null,
          attachedAt: null,
          attachFromStatus: null,
        },
      } as never,
      { returnDocument: 'after' },
    ).lean()) as Doc | null;
    if (updated) {
      logger.info(
        { event: 'storage_released', storageId, cloudHostId, status: fromStatus },
        'cloud storage released',
      );
    }
    return updated;
  }

  /** terminal 回调携带 `storage.archiveStatus=pending/running` 时推进 `ATTACHED → ARCHIVING`。
   *  `archiveId`（cloud-controller 本次归档 id）用于开启新归档周期：与旧周期不同则重置
   *  currentArchive 为 PENDING 占位，避免上一轮 SUCCEEDED 污染本轮回调判定。 */
  async markArchiving(
    storageId: string,
    cloudHostId?: string | null,
    archiveId?: string | null,
  ): Promise<Doc | null> {
    if (!mongoose.isValidObjectId(storageId)) return null;
    const filter: Record<string, unknown> = { _id: storageId, status: 'ATTACHED' };
    if (cloudHostId) filter.attachedCloudHostId = cloudHostId;
    const updated = (await CloudStorage.findOneAndUpdate(
      filter,
      { $set: { status: 'ARCHIVING', billingRate: 'FULL' } },
      { returnDocument: 'after' },
    ).lean()) as Doc | null;
    const current = updated ?? ((await CloudStorage.findOne({ _id: storageId }).lean()) as Doc | null);
    if (!current) return null;
    const previous = current.currentArchive as Doc | null;
    const previousId = previous?.archiveId ? String(previous.archiveId) : null;
    if (archiveId && previousId !== archiveId) {
      // 新归档周期：占位 currentArchive，旧周期的迟到回调按「非当前 archiveId」忽略。
      const placeholder = {
        archiveId,
        containerId: str(previous?.containerId),
        cloudHostId: current.attachedCloudHostId ?? previous?.cloudHostId ?? null,
        cloudHostName: str(previous?.cloudHostName),
        fileName: str(previous?.fileName) ?? '',
        path: str(previous?.path),
        status: 'PENDING',
        usageBytes: null,
        startedAt: new Date(),
        finishedAt: null,
        failureReason: null,
      };
      const withPlaceholder = (await CloudStorage.findOneAndUpdate(
        { _id: storageId, status: 'ARCHIVING' },
        { $set: { currentArchive: placeholder } },
        { returnDocument: 'after' },
      ).lean()) as Doc | null;
      if (withPlaceholder) return withPlaceholder;
    } else if (!archiveId && previous) {
      // 旧版 cloud-controller 未下发 archiveId：清除上一周期归档，避免新周期回调被旧 SUCCEEDED 拦截。
      const cleared = (await CloudStorage.findOneAndUpdate(
        { _id: storageId, status: 'ARCHIVING' },
        { $set: { currentArchive: null } },
        { returnDocument: 'after' },
      ).lean()) as Doc | null;
      if (cleared) return cleared;
    }
    if (updated) {
      logger.info({ event: 'archive_started', storageId }, 'cloud storage archiving');
    }
    return current;
  }

  /** 记录本次挂载的容器（归档重试/对账用；仅在仍处于本次挂载时写入）。 */
  async recordContainer(storageId: string, cloudHostId: string, containerId: string): Promise<void> {
    if (!mongoose.isValidObjectId(storageId)) return;
    await CloudStorage.updateOne(
      { _id: storageId, attachedCloudHostId: cloudHostId },
      { $set: { lastContainerId: containerId } },
    ).catch(() => undefined);
  }

  /**
   * 归档回调（cloud-controller → agent-api）：按 archiveId 幂等、终态单调。
   * - SUCCEEDED：`ARCHIVING → ARCHIVED` + `billingRate=HALF`，清 attached/attachFromStatus；
   * - FAILED：保持 `ARCHIVING` + 失败标记（可重试）；
   * - SUCCEEDED 之后迟到的 RUNNING/FAILED 被忽略。
   */
  async handleArchiveCallback(storageId: string, input: ArchiveCallbackInput): Promise<Doc | null> {
    if (!mongoose.isValidObjectId(storageId)) return null;
    const doc = (await CloudStorage.findById(storageId).lean()) as Doc | null;
    if (!doc) return null;
    const existing = doc.currentArchive as Doc | null;
    const existingId = existing?.archiveId ? String(existing.archiveId) : null;
    const sameArchive = existingId !== null && existingId === input.archiveId;
    const existingTerminal = sameArchive && isArchiveTerminal(existing?.status);
    if (existingTerminal) return this.present(doc);
    // 非当前归档周期的迟到回调一律忽略（旧周期的 SUCCEEDED/FAILED 不得覆盖新周期）：
    // - 已 ARCHIVED 且旧回调为 SUCCEEDED；
    // - 当前处于 ARCHIVING 且已存在另一个 archiveId（新周期占位/运行中）。
    if (existing && !sameArchive && existingId !== null) {
      if (String(existing.status) === 'SUCCEEDED' && String(doc.status) === 'ARCHIVED') {
        return this.present(doc);
      }
      if (String(doc.status) === 'ARCHIVING') {
        return this.present(doc);
      }
    }

    const now = new Date();
    const startedAt =
      input.startedAt && !Number.isNaN(Date.parse(input.startedAt))
        ? new Date(input.startedAt)
        : existing?.startedAt instanceof Date
          ? existing.startedAt
          : now;
    const finishedAt =
      input.finishedAt && !Number.isNaN(Date.parse(input.finishedAt))
        ? new Date(input.finishedAt)
        : now;
    const common = {
      archiveId: input.archiveId,
      containerId: input.containerId ?? str(existing?.containerId),
      cloudHostId: input.cloudHostId ?? existing?.cloudHostId ?? null,
      cloudHostName: input.cloudHostName ?? str(existing?.cloudHostName),
      fileName: input.fileName ?? str(existing?.fileName),
      path: input.path ?? str(existing?.path),
      startedAt,
      // 裁决 13：归档成功但源 PVC 删除失败时留痕（false），供运维/再挂载先删后建判断。
      sourcePvcReleased:
        input.sourcePvcReleased ?? existing?.sourcePvcReleased ?? null,
    };

    if (input.status === 'RUNNING') {
      // 允许 ATTACHED（RUNNING 回调早于 terminal 的 markArchiving）与 ARCHIVING。
      if (String(doc.status) !== 'ARCHIVING' && String(doc.status) !== 'ATTACHED') {
        return this.present(doc);
      }
      const updated = (await CloudStorage.findOneAndUpdate(
        { _id: storageId, status: { $in: ['ATTACHED', 'ARCHIVING'] } },
        {
          $set: {
            currentArchive: {
              ...common,
              status: 'RUNNING',
              usageBytes: input.usageBytes ?? existing?.usageBytes ?? null,
              finishedAt: null,
              failureReason: null,
            },
          },
        },
        { returnDocument: 'after' },
      ).lean()) as Doc | null;
      return updated ? this.present(updated) : this.present(doc);
    }

    if (input.status === 'FAILED') {
      if (!['ATTACHING', 'ATTACHED', 'ARCHIVING'].includes(String(doc.status))) {
        return this.present(doc);
      }
      const updated = (await CloudStorage.findOneAndUpdate(
        { _id: storageId, status: { $in: ['ATTACHED', 'ARCHIVING'] }, 'currentArchive.status': { $ne: 'SUCCEEDED' } },
        {
          $set: {
            status: 'ARCHIVING',
            currentArchive: {
              ...common,
              status: 'FAILED',
              usageBytes: input.usageBytes ?? existing?.usageBytes ?? null,
              finishedAt,
              failureReason: input.failureReason ?? 'archive failed',
            },
          },
        },
        { returnDocument: 'after' },
      ).lean()) as Doc | null;
      if (!updated) return this.present(doc);
      logger.warn(
        { event: 'archive_failed', storageId, archiveId: input.archiveId },
        'cloud storage archive failed',
      );
      return this.present(updated);
    }

    // SUCCEEDED
    const updated = (await CloudStorage.findOneAndUpdate(
      {
        _id: storageId,
        status: { $in: ['ATTACHED', 'ARCHIVING'] },
        'currentArchive.status': { $ne: 'SUCCEEDED' },
      },
      {
        $set: {
          status: 'ARCHIVED',
          billingRate: 'HALF',
          usageBytes: input.usageBytes ?? existing?.usageBytes ?? null,
          usageUpdatedAt: finishedAt,
          currentArchive: {
            ...common,
            status: 'SUCCEEDED',
            usageBytes: input.usageBytes ?? existing?.usageBytes ?? null,
            finishedAt,
            failureReason: null,
          },
          attachedCloudHostId: null,
          attachedControllerId: null,
          attachedBy: null,
          attachedAt: null,
          attachFromStatus: null,
        },
      },
      { returnDocument: 'after' },
    ).lean()) as Doc | null;
    if (!updated) return this.present(doc);
    logger.info(
      {
        event: 'archive_succeeded',
        storageId,
        archiveId: input.archiveId,
        usageBytes: input.usageBytes ?? null,
      },
      'cloud storage archived',
    );
    return this.present(updated);
  }

  /** 用量回调：仅更新最近一次测量值（失败/缺失不影响状态机）。 */
  async handleUsageCallback(storageId: string, input: UsageCallbackInput): Promise<Doc | null> {
    if (!mongoose.isValidObjectId(storageId)) return null;
    const usageBytes = Number(input.usageBytes);
    if (!Number.isFinite(usageBytes) || usageBytes < 0) return null;
    const measuredAt =
      input.measuredAt && !Number.isNaN(Date.parse(input.measuredAt))
        ? new Date(input.measuredAt)
        : new Date();
    const updated = (await CloudStorage.findOneAndUpdate(
      { _id: storageId },
      { $set: { usageBytes, usageUpdatedAt: measuredAt } },
      { returnDocument: 'after' },
    ).lean()) as Doc | null;
    if (!updated) return null;
    logger.info({ event: 'usage_callback', storageId, usageBytes }, 'cloud storage usage updated');
    return this.present(updated);
  }

  /**
   * terminal 回调兜底：按最近容器查询归档终态并补齐（回调丢失时避免永久卡 ATTACHED）。
   * 返回 true 表示已收口（成功转 ARCHIVED / 失败保持 ARCHIVING 记失败标记）。
   */
  async reconcileFromTerminal(
    storageId: string,
    containerId: string | null,
  ): Promise<boolean> {
    if (!mongoose.isValidObjectId(storageId)) return false;
    let targetContainerId = containerId;
    if (!targetContainerId) {
      const doc = (await CloudStorage.findById(storageId).select('lastContainerId').lean()) as Doc | null;
      targetContainerId = str(doc?.lastContainerId);
    }
    if (!targetContainerId) return false;
    try {
      const archive = await this.controllerClient.getArchive(targetContainerId);
      if (!archive.archiveId) return false;
      if (archive.status !== 'SUCCEEDED' && archive.status !== 'FAILED') return false;
      await this.handleArchiveCallback(storageId, {
        archiveId: archive.archiveId,
        containerId: targetContainerId,
        status: archive.status,
        usageBytes: archive.usageBytes ?? null,
        startedAt: archive.startedAt ?? null,
        finishedAt: archive.finishedAt ?? null,
        failureReason: archive.failureReason ?? null,
      });
      return true;
    } catch (err) {
      logger.warn(
        { event: 'archive_terminal_reconcile_failed', storageId, containerId: targetContainerId, err },
        'cloud storage terminal reconcile failed',
      );
      return false;
    }
  }

  /**
   * `ARCHIVING` 对账兜底：超过阈值仍未收口时，按最近容器查询归档状态；
   * 已成功/失败的回调漏投时补齐（幂等）。返回实际处理的存储数。
   */
  async reconcileARCHIVING(options: { olderThanMs?: number } = {}): Promise<number> {
    const olderThanMs = options.olderThanMs ?? ARCHIVING_RECONCILE_AFTER_MS;
    const threshold = new Date(Date.now() - olderThanMs);
    const docs = (await CloudStorage.find({
      status: 'ARCHIVING',
      updatedAt: { $lte: threshold },
    })
      .limit(20)
      .lean()) as Doc[];
    let handled = 0;
    for (const doc of docs) {
      const containerId = str(doc.lastContainerId);
      if (!containerId) continue;
      try {
        const archive = await this.controllerClient.getArchive(containerId);
        const archiveId = str(archive.archiveId) ?? str((doc.currentArchive as Doc | null)?.archiveId);
        if (!archiveId || archive.status === 'NONE' || archive.status === 'PENDING' || archive.status === 'RUNNING') {
          continue;
        }
        await this.handleArchiveCallback(String(doc._id), {
          archiveId,
          containerId,
          status: archive.status,
          usageBytes: archive.usageBytes ?? null,
          startedAt: archive.startedAt ?? null,
          finishedAt: archive.finishedAt ?? null,
          failureReason: archive.failureReason ?? null,
        });
        handled += 1;
      } catch (err) {
        logger.warn(
          { event: 'archive_reconcile_failed', storageId: String(doc._id), err },
          'cloud storage archive reconcile failed',
        );
      }
    }
    return handled;
  }

  // ---- mapping ----

  private mapArchive(value: unknown): Doc | null {
    if (!value || typeof value !== 'object') return null;
    const archive = value as Doc;
    if (!archive.archiveId) return null;
    return {
      id: String(archive.archiveId),
      fileName: String(archive.fileName ?? ''),
      status: archive.status,
      cloudHostId: archive.cloudHostId ? String(archive.cloudHostId) : null,
      cloudHostName: archive.cloudHostName ?? null,
      usageBytes: archive.usageBytes ?? null,
      startedAt: iso(archive.startedAt),
      finishedAt: iso(archive.finishedAt),
      failureReason: archive.failureReason ?? null,
      sourcePvcReleased:
        typeof archive.sourcePvcReleased === 'boolean' ? archive.sourcePvcReleased : null,
    };
  }

  private mapStorage(doc: Doc): Doc {
    return {
      id: String(doc._id),
      name: String(doc.name ?? ''),
      sizeGi: Number(doc.sizeGi ?? 0),
      status: doc.status,
      // 契约：待挂载（从未写入）实际占用为 0；未知为 null（已归档/挂载中未采集）。
      usageBytes:
        doc.usageBytes === null || doc.usageBytes === undefined
          ? doc.status === 'IDLE'
            ? 0
            : null
          : doc.usageBytes,
      usageUpdatedAt: iso(doc.usageUpdatedAt),
      createdById: doc.createdBy ? String(doc.createdBy) : null,
      createdAt: iso(doc.createdAt) ?? new Date(0).toISOString(),
      attachedCloudHostId: doc.attachedCloudHostId ? String(doc.attachedCloudHostId) : null,
      attachedAt: iso(doc.attachedAt),
      currentArchive: this.mapArchive(doc.currentArchive),
      failureReason: doc.failureReason ?? null,
      destroyedAt: iso(doc.destroyedAt),
      // 内部字段（resolver/测试使用；不直接暴露）
      billingRate: doc.billingRate ?? 'FULL',
      resourceWorkspaceId: doc.resourceWorkspaceId ? String(doc.resourceWorkspaceId) : null,
      _raw: doc,
    };
  }

  private async present(doc: Doc): Promise<Doc> {
    const [view] = await this.presentMany([doc]);
    return view;
  }

  private async presentMany(docs: Doc[]): Promise<Doc[]> {
    if (docs.length === 0) return [];
    const hostIds = Array.from(
      new Set(
        docs
          .map((doc) => (doc.attachedCloudHostId ? String(doc.attachedCloudHostId) : ''))
          .filter(Boolean),
      ),
    );
    const creatorIds = Array.from(
      new Set(
        docs.map((doc) => (doc.createdBy ? String(doc.createdBy) : '')).filter(Boolean),
      ),
    );
    const [hosts, creators] = await Promise.all([
      hostIds.length
        ? (CloudHost.find({ _id: { $in: hostIds } })
            .select('name')
            .lean() as unknown as Promise<Doc[]>)
        : Promise.resolve([] as Doc[]),
      creatorIds.length
        ? (User.find({ _id: { $in: creatorIds } })
            .select('name username')
            .lean() as unknown as Promise<Doc[]>)
        : Promise.resolve([] as Doc[]),
    ]);
    const hostNames = new Map(hosts.map((host) => [String(host._id), String(host.name ?? '')]));
    const creatorNames = new Map(
      creators.map((user) => [
        String(user._id),
        String(user.name ?? user.username ?? user._id),
      ]),
    );
    return docs.map((doc) => {
      const view = this.mapStorage(doc);
      const createdById = view.createdById ? String(view.createdById) : null;
      return {
        ...view,
        createdBy: createdById
          ? { id: createdById, name: creatorNames.get(createdById) ?? createdById }
          : { id: '', name: '' },
        attachedCloudHostName: view.attachedCloudHostId
          ? hostNames.get(String(view.attachedCloudHostId)) ?? null
          : null,
      };
    });
  }
}

function quoteCents(sizeGi: number): { base: number; tier1: number; tier2: number; full: number } {  const base = 500;
  const tier1 = Math.max(0, Math.min(sizeGi, 25) - 10) * 100;
  const tier2 = Math.max(0, sizeGi - 25) * 300;
  return { base, tier1, tier2, full: base + tier1 + tier2 };
}

/**
 * 本地默认阶梯报价（分 → credits），用于 admin-api 报价不可用/未部署时的降级展示与
 * 首小时余额校验；与 admin-api `quoteStorageHourly` 同口径。
 */
export function fallbackStorageQuote(sizeGi: number): {
  sizeGi: number;
  full: { hourlyCredits: number; items: Array<{ productId: string; quantity: number; unitPriceCredits: number; amountCredits: number }> };
  archived: { hourlyCredits: number; items: Array<{ productId: string; quantity: number; unitPriceCredits: number; amountCredits: number }> };
} {
  const cents = quoteCents(sizeGi);
  const items = [
    { productId: 'cloud_storage.base.hour', quantity: 1, unitPriceCredits: cents.base / 100, amountCredits: cents.base / 100 },
    { productId: 'cloud_storage.tier1.gib_hour', quantity: Math.max(0, Math.min(sizeGi, 25) - 10), unitPriceCredits: 1, amountCredits: cents.tier1 / 100 },
    { productId: 'cloud_storage.tier2.gib_hour', quantity: Math.max(0, sizeGi - 25), unitPriceCredits: 3, amountCredits: cents.tier2 / 100 },
  ].filter((item) => item.quantity > 0);
  return {
    sizeGi,
    full: { hourlyCredits: cents.full / 100, items },
    archived: {
      hourlyCredits: cents.full / 200,
      items: items.map((item) => ({
        ...item,
        unitPriceCredits: item.unitPriceCredits / 2,
        amountCredits: item.amountCredits / 2,
      })),
    },
  };
}

export const cloudStorageService = new CloudStorageService();

/** 定时对账 ARCHIVING（回调最终丢失兜底）；与 admin-api scheduler 同模式，定时器 unref。 */
export function scheduleCloudStorageReconcile(intervalMs: number): NodeJS.Timeout {
  const run = () => {
    void cloudStorageService.reconcileARCHIVING().catch((err) => {
      logger.warn({ event: 'archive_reconcile_tick_failed', err }, 'storage reconcile tick failed');
    });
  };
  run();
  const timer = setInterval(run, Math.max(intervalMs, 60_000));
  timer.unref?.();
  return timer;
}

/** 契约允许透传的错误文案（未命中统一 internal error，避免泄露 Mongo/驱动信息）。 */
const CLOUD_STORAGE_PUBLIC_ERRORS = new Set([
  'storage feature is disabled',
  'storage name is required',
  'storage name is too long',
  'storage name already exists',
  'storage size must be between 1 and 30 Gi',
  'storage not found',
  'storage is not attachable',
  'storage is attached',
  'storage is archiving',
  'storage is not destroyable',
  'not allowed to destroy storage',
  'global workspace is read-only',
  'insufficient balance',
  'no archive to retry',
  'storage is not attached',
  'billing service unavailable',
  'control plane unavailable',
  'workspace not found',
]);

export function toCloudStorageGraphQLError(err: unknown): never {
  if (err instanceof GraphQLError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (CLOUD_STORAGE_PUBLIC_ERRORS.has(message)) throw new GraphQLError(message);
  throw new GraphQLError('internal error');
}

