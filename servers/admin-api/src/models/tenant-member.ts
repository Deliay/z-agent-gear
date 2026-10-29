import mongoose from 'mongoose';

/**
 * 租户成员关系只读镜像（集合名与 agent-api 的 `tenantmembers` 严格对齐）。
 *
 * 与 agent-api 同步演进，只读镜像：单一事实源在 agent-api（`tenant-member-service`
 * 与 `/internal/tenants*`、`/internal/users` 开户）——本模型仅供后台租户成员/角色只读查询，
 * admin-api 不创建、不更新、不删除。
 *
 * 口径（多租户二期）：
 * - 覆盖全部租户（personal 恒 1 行且 `role='admin'`；team 由后台初始化/租户管理员变更）；
 * - `users.tenantId` 保留为「个人租户指针」，成员关系/角色/成员数的唯一事实源是本集合；
 * - **不挂作用域插件**（agent-api 侧 F6 裁决），后台查询一律显式 `{tenantId}` 条件。
 */
const tenantMemberSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['admin', 'developer'], required: true, default: 'developer' },
    // 操作来源：admin 用户 id / 租户管理员 userId / 'migration' / 'provision'
    createdBy: { type: String, default: null },
  },
  { collection: 'tenantmembers', timestamps: true },
);

tenantMemberSchema.index({ tenantId: 1, userId: 1 }, { unique: true });

export const TenantMember = mongoose.model('TenantMember', tenantMemberSchema);
export type ITenantMember = mongoose.InferSchemaType<typeof tenantMemberSchema> & {
  role: 'admin' | 'developer';
};
