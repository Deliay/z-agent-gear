import mongoose from 'mongoose';

/**
 * 工作负载只读模型（集合 `cloudworkloads`）。
 *
 * 工作负载由 admin-api 写入，cloud-controller 仅只读，用于在容器回连（init）与
 * 销毁（post）时读取脚本并写入执行日志快照（契约 §2.9、提案 §4.1）。
 */
const cloudWorkloadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    initScript: { type: String, default: null },
    postScript: { type: String, default: null },
  },
  { timestamps: true, collection: 'cloudworkloads' },
);

export const CloudWorkload = mongoose.model('CloudWorkload', cloudWorkloadSchema);

export type ICloudWorkload = mongoose.InferSchemaType<typeof cloudWorkloadSchema>;
