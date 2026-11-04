import mongoose from 'mongoose';

export const STORAGE_OPERATION_TYPES = ['archive', 'restore'] as const;
export type StorageOperationType = (typeof STORAGE_OPERATION_TYPES)[number];

export const STORAGE_OPERATION_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
] as const;
export type StorageOperationStatus = (typeof STORAGE_OPERATION_STATUSES)[number];

/**
 * 存储级归档/复原操作台账（集合 `cloudstorageoperations`，仅 cloud-controller 写）。
 *
 * 承载「无容器」的存储级操作（手动归档 / 复原到归档 / fork），镜像容器级归档的
 * 幂等（`_id = operationId`）、唯一进行中（部分唯一索引）与巡检重投语义。
 * 契约见 `contracts/cloud-controller-websocket.md` A.2.11 ~ A.2.13。
 */
const cloudStorageOperationSchema = new mongoose.Schema(
  {
    // operationId（24 位 hex ObjectId）；由 agent-api 生成并作为幂等键。
    _id: { type: mongoose.Schema.Types.ObjectId, required: true },
    /** 目标存储（fork 时为新存储）。 */
    storageId: { type: String, required: true, index: true },
    workspaceId: { type: String, required: true },
    tenantId: { type: String, default: null },
    type: { type: String, enum: STORAGE_OPERATION_TYPES, required: true },
    status: {
      type: String,
      enum: STORAGE_OPERATION_STATUSES,
      required: true,
      default: 'pending',
    },
    /** type=archive：归档 id（随 A.2.10 回调上报）。 */
    archiveId: { type: String, default: null },
    /** type=archive：归档文件名。 */
    fileName: { type: String, default: null },
    /** type=restore：源归档完整路径。 */
    archivePath: { type: String, default: null },
    /** type=restore：目标容量/StorageClass 快照（重建 PVC 用）。 */
    sizeGi: { type: Number, default: null },
    storageClass: { type: String, default: null },
    /** 归档/复原完成后采集的占用（字节）。 */
    usageBytes: { type: Number, default: null },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    /** 终态回调是否已成功送达（巡检重投依据）。 */
    callbackDeliveredAt: { type: Date, default: null },
  },
  { collection: 'cloudstorageoperations', timestamps: true },
);

// 同一存储只允许一个进行中操作（部分唯一索引，天然抗并发；D11）。
cloudStorageOperationSchema.index(
  { storageId: 1 },
  {
    unique: true,
    name: 'uniq_storage_op_inflight',
    partialFilterExpression: { status: { $in: ['pending', 'running'] } },
  },
);
// 巡检扫描进行中/超时操作。
cloudStorageOperationSchema.index({ status: 1, updatedAt: 1 }, { name: 'storage_op_status' });
// 运维按存储查看历史。
cloudStorageOperationSchema.index(
  { storageId: 1, createdAt: -1 },
  { name: 'storage_op_history' },
);

export const CloudStorageOperation = mongoose.model(
  'CloudStorageOperation',
  cloudStorageOperationSchema,
);

export type ICloudStorageOperation = mongoose.InferSchemaType<
  typeof cloudStorageOperationSchema
>;
