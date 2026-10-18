import mongoose from 'mongoose';

/**
 * 本次启动最终执行计划子文档（提案 §4.1）：`workloadId`/`params`/`implicit`。
 * 与 cloud-controller 的 `cloudcontainers.workloadPlan` 严格对齐（只读模型）。
 */
const workloadPlanItemSchema = new mongoose.Schema(
  {
    workloadId: { type: mongoose.Schema.Types.ObjectId, required: true },
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    implicit: { type: Boolean, default: false },
    required: { type: Boolean, default: false },
  },
  { _id: false },
);

/**
 * 降级只读模型（裁决 12）：集合名与 cloud-controller 的 `cloudcontainers` 严格对齐。
 * admin-api 单一事实源在 cloud-controller——本模型**仅用于 find**（控制面不可达时列表降级），
 * 不创建、不更新、不删除，避免双写不一致。
 */
const cloudContainerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    namespace: { type: String },
    status: {
      type: String,
      enum: ['creating', 'connecting', 'initializing', 'online', 'destroying', 'exited', 'failed'],
      default: 'creating',
    },
    purpose: {
      type: String,
      enum: ['idle', 'admin-task', 'workflow', 'session'],
    },
    refId: { type: String },
    // 与 cloud-controller schema 对齐（userId 为 String，避免同一集合 schema 漂移）
    userId: { type: String },
    image: { type: String },
    connectedAt: { type: Date },
    exitedAt: { type: Date },
    exitReason: { type: String },
    // 启动时挂载的工作负载，按选择顺序保存；与 cloud-controller schema 对齐
    workloadIds: { type: [String], default: [] },
    // 本次启动最终执行计划，顺序即执行顺序；与 cloud-controller schema 对齐
    workloadPlan: { type: [workloadPlanItemSchema], default: [] },
    // 初始化中当前正在执行的工作负载脚本名称；非初始化中为 null
    currentWorkloadName: { type: String, default: null },
  },
  { collection: 'cloudcontainers', timestamps: true },
);

export const CloudContainer = mongoose.model('CloudContainer', cloudContainerSchema);

/**
 * 读取落库的容器文档（只读降级路径）。
 * 返回原始 lean 文档，由调用方经 `mapCloudContainer` 归一为契约形态，避免此处重复映射逻辑。
 */
export async function findStoredCloudContainers(): Promise<Array<Record<string, unknown>>> {
  const docs = await CloudContainer.find().sort({ createdAt: -1 }).lean();
  return docs as unknown as Array<Record<string, unknown>>;
}
