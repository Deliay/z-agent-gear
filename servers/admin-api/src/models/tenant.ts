import mongoose from 'mongoose';

/**
 * 租户只读镜像（集合名与 agent-api 的 `tenants` 严格对齐）。
 *
 * 单一事实源在 agent-api——本模型**仅供后台租户只读查询**，admin-api 不创建、不更新、不删除。
 * tenants 不持有成员列表：成员关系由 `users.tenantId` 承载（tenant→users 一对多）。
 * 一期仅 `personal`（个人专属，`_id` 复用 userId、单成员）；team 为二期预留。
 * 与 agent-api **同步演进**（字段变更必须双服务同 PR）。
 */
const tenantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    type: { type: String, enum: ['personal', 'team'], default: 'personal', index: true },
  },
  { collection: 'tenants', timestamps: true },
);

export const Tenant = mongoose.model('Tenant', tenantSchema);
export type ITenant = mongoose.InferSchemaType<typeof tenantSchema>;
