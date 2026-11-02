import mongoose from 'mongoose';
import { applyWorkspaceScope } from '../services/workspace-scope.js';

export const CLOUD_STORAGE_STATUSES = [
  'CREATING',
  'IDLE',
  'ATTACHING',
  'ATTACHED',
  'ARCHIVING',
  'ARCHIVED',
  'DESTROYING',
  'DESTROYED',
  'CREATE_FAILED',
] as const;

export type CloudStorageStatus = (typeof CLOUD_STORAGE_STATUSES)[number];

export const CLOUD_STORAGE_ARCHIVE_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
] as const;

export type CloudStorageArchiveStatus = (typeof CLOUD_STORAGE_ARCHIVE_STATUSES)[number];

/** 本次挂载来源状态（裁决 3）：创建失败回滚与「正在恢复数据」判定用。 */
export const CLOUD_STORAGE_ATTACH_FROM_STATUSES = ['IDLE', 'ARCHIVED'] as const;
export type CloudStorageAttachFromStatus = (typeof CLOUD_STORAGE_ATTACH_FROM_STATUSES)[number];

const archiveSchema = new mongoose.Schema(
  {
    archiveId: { type: String, required: true },
    containerId: { type: String, default: null },
    cloudHostId: { type: mongoose.Schema.Types.ObjectId, ref: 'CloudHost', default: null },
    cloudHostName: { type: String, default: null },
    fileName: { type: String, required: true },
    path: { type: String, required: true },
    status: {
      type: String,
      enum: CLOUD_STORAGE_ARCHIVE_STATUSES,
      required: true,
    },
    usageBytes: { type: Number, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
  },
  { _id: false },
);

/**
 * 工作区级云存储（集合 `cloudstorages`，仅 agent-api 写）。
 *
 * 状态机见 `contracts/cloud-storage.graphql` / 提案 §实现点 10；所有状态迁移在
 * `services/cloud-storage-service.ts` 内以 `findOneAndUpdate({_id,status:from})` CAS 完成。
 *
 * 作用域（计划期裁决 2）：仅挂 `applyWorkspaceScope({workspaceField:'resourceWorkspaceId'})`；
 * `tenantId` 由 service 显式写入，**不加入** `TENANT_ID_COLLECTIONS`（本集合以 createdBy 标识创建人）。
 */
const cloudStorageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // 大小写不敏感唯一：name.toLocaleLowerCase()（已销毁记录释放名称）
    nameKey: { type: String, required: true },
    sizeGi: { type: Number, required: true, min: 1, max: 30 },
    status: {
      type: String,
      enum: CLOUD_STORAGE_STATUSES,
      required: true,
      default: 'CREATING',
    },

    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    resourceWorkspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    pvcName: { type: String, required: true },
    storageClass: { type: String, default: null },

    attachedCloudHostId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CloudHost',
      default: null,
    },
    attachedControllerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Controller',
      default: null,
    },
    attachedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    attachedAt: { type: Date, default: null },
    // 本次挂载来源（IDLE/ARCHIVED/null）：创建失败回滚与恢复中提示使用
    attachFromStatus: {
      type: String,
      enum: CLOUD_STORAGE_ATTACH_FROM_STATUSES,
      default: null,
    },

    lastContainerId: { type: String, default: null },

    usageBytes: { type: Number, default: null },
    usageUpdatedAt: { type: Date, default: null },

    currentArchive: { type: archiveSchema, default: null },

    billingAccountId: { type: String, default: null },
    billingRate: { type: String, enum: ['FULL', 'HALF'], default: 'FULL' },
    billingStartedAt: { type: Date, default: null },

    failureReason: { type: String, default: null },
    destroyReason: { type: String, default: null },
    // DESTROYED / CREATE_FAILED 时写入（名称即释放；已销毁记录进入折叠区）
    destroyedAt: { type: Date, default: null },
  },
  { collection: 'cloudstorages', timestamps: true },
);

// 工作区内名称唯一（销毁后允许重建）
cloudStorageSchema.index(
  { resourceWorkspaceId: 1, nameKey: 1 },
  {
    unique: true,
    name: 'uniq_cloud_storage_workspace_name',
    partialFilterExpression: { destroyedAt: null },
  },
);
// 一块存储只能挂一台云电脑（attachedCloudHostId 非空时唯一）
cloudStorageSchema.index(
  { attachedCloudHostId: 1 },
  {
    unique: true,
    name: 'uniq_cloud_storage_attached_host',
    partialFilterExpression: { attachedCloudHostId: { $type: 'objectId' } },
  },
);
cloudStorageSchema.index({ tenantId: 1 }, { name: 'cloud_storage_tenant' });
cloudStorageSchema.index(
  { resourceWorkspaceId: 1, status: 1 },
  { name: 'cloud_storage_workspace_status' },
);
// 计费 tick 扫描（admin-api 只读镜像共用同一索引）
cloudStorageSchema.index(
  { status: 1, billingStartedAt: 1 },
  { name: 'cloud_storage_status_billing' },
);

applyWorkspaceScope(cloudStorageSchema, { workspaceField: 'resourceWorkspaceId' });

export const CloudStorage = mongoose.model('CloudStorage', cloudStorageSchema);
export type ICloudStorage = mongoose.InferSchemaType<typeof cloudStorageSchema>;
