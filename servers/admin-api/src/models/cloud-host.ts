import mongoose from 'mongoose';

/**
 * 云电脑只读模型（集合名与 agent-api 的 `cloudhosts` 严格对齐）。
 *
 * 单一事实源在 agent-api——本模型**仅供计费网关鉴权与每日对账读取**，
 * admin-api 不创建、不更新、不删除，避免双写不一致。
 */
const cloudHostSchema = new mongoose.Schema(
  {
    // agent-api 侧为 ObjectId；对账/鉴权只按 _id 查
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // 多租户二期：agent-api 写入的租户维度；tenant 计费归属按此校验（历史行可能为 null）
    tenantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    status: {
      type: String,
      enum: ['STARTING', 'RUNNING', 'STOPPING', 'STOPPED', 'FAILED'],
      default: 'STARTING',
    },
    controllerId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // 软删除标记：非空表示已从列表隐藏，运行 Key 必须立即失效
    deletedAt: { type: Date, default: null },
  },
  { collection: 'cloudhosts', timestamps: true },
);

export const CloudHost = mongoose.model('CloudHost', cloudHostSchema);
export type ICloudHost = mongoose.InferSchemaType<typeof cloudHostSchema>;
