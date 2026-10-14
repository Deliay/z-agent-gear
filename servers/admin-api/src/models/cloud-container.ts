import mongoose from 'mongoose';

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
      enum: ['creating', 'connecting', 'online', 'destroying', 'exited', 'failed'],
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
