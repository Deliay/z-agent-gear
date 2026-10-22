import mongoose from 'mongoose';

export const CLOUD_HOST_STATUSES = [
  'STARTING',
  'RUNNING',
  'STOPPING',
  'STOPPED',
  'FAILED',
] as const;

export type CloudHostStatus = (typeof CLOUD_HOST_STATUSES)[number];

export const HARNESS_TYPES = ['OPENCODE'] as const;

export type HarnessType = (typeof HARNESS_TYPES)[number];

/**
 * 前台云电脑（集合 `cloudhosts`）。
 *
 * 生命周期：创建即启动 → 停止即销毁。`status` 是云电脑生命周期的唯一事实源；
 * `STARTING/RUNNING/STOPPING` 计入每用户 1 实例上限，`STOPPED/FAILED` 为终态。
 * `deletedAt` 非空表示软删除（列表隐藏，Controller/会话/消息留档）。
 */
const cloudHostSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    harnessTypes: {
      type: [String],
      enum: HARNESS_TYPES,
      default: [],
    },
    status: {
      type: String,
      enum: CLOUD_HOST_STATUSES,
      default: 'STARTING',
      index: true,
    },
    controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true, index: true },
    keyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ControllerKey', required: true },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ControllerWorkspace', required: true },
    containerId: { type: String, default: null },
    defaultSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null },
    startedAt: { type: Date, default: null },
    readyAt: { type: Date, default: null },
    stoppedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  { collection: 'cloudhosts', timestamps: true },
);

cloudHostSchema.index({ userId: 1, status: 1 });
cloudHostSchema.index({ controllerId: 1 });
// A-5：每用户同时最多 1 个活跃云电脑（多副本部署时由 DB 兜底；进程内 KeyedMutex 仅单实例优化）。
cloudHostSchema.index(
  { userId: 1 },
  {
    unique: true,
    name: 'uniq_active_cloud_host_per_user',
    partialFilterExpression: {
      status: { $in: ['STARTING', 'RUNNING', 'STOPPING'] },
      deletedAt: null,
    },
  },
);

export const CloudHost = mongoose.model('CloudHost', cloudHostSchema);
export type ICloudHost = mongoose.InferSchemaType<typeof cloudHostSchema>;
