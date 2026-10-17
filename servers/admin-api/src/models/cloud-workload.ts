import mongoose from 'mongoose';

/**
 * 工作负载定义（集合名与提案 §4.1 严格对齐：`cloudworkloads`）。
 * admin-api 为写入方（CRUD）；cloud-controller 只读该集合以读取脚本。
 * 校验规则（名称 trim 后 1~64/唯一、脚本 ≤16 KiB、至少其一非空）由服务层强制。
 */
const cloudWorkloadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    initScript: { type: String, default: null },
    postScript: { type: String, default: null },
  },
  { collection: 'cloudworkloads', timestamps: true },
);

export const CloudWorkload = mongoose.model('CloudWorkload', cloudWorkloadSchema);
export type ICloudWorkload = mongoose.InferSchemaType<typeof cloudWorkloadSchema>;
