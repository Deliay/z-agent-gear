import mongoose from 'mongoose';
import { TENANT_ROLES, type TenantRole } from '../services/workspace-context.js';

/**
 * 租户成员关系（集合 `tenantmembers`，多租户二期）。
 *
 * - 覆盖全部租户：personal 恒 1 行且 `role='admin'`；team 由后台初始化/租户管理员变更；
 * - `users.tenantId` 保留为「个人租户指针」，成员关系/角色/成员数的唯一事实源是本集合；
 * - **不挂 tenant-scope / workspace-scope 插件**（F6 裁决：本集合自身带 userId+tenantId，
 *   插件注入会与「用户可同时属个人租户 + 多团队」语义冲突，查询一律显式 `{tenantId,userId}`）。
 */
const tenantMemberSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: TENANT_ROLES, required: true, default: 'developer' },
    // 操作来源：admin 用户 id / 租户管理员 userId / 'migration' / 'provision'
    createdBy: { type: String, default: null },
  },
  { collection: 'tenantmembers', timestamps: true },
);

tenantMemberSchema.index({ tenantId: 1, userId: 1 }, { unique: true });

export const TenantMember = mongoose.model('TenantMember', tenantMemberSchema);
export type ITenantMember = mongoose.InferSchemaType<typeof tenantMemberSchema> & { role: TenantRole };
