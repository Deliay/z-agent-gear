import mongoose from 'mongoose';
import { WORKSPACE_TYPES } from '../services/workspace-context.js';

/** 全局工作区固定名称（部分唯一索引 + 服务层硬约束双保险）。 */
export const GLOBAL_WORKSPACE_NAME = '全局工作区';

/**
 * 租户工作区（集合 `workspaces`，多租户二期）。
 *
 * - 每租户恰一个 `type='global'`（部分唯一索引 `uniq_global_workspace_per_tenant`）；
 * - `normal` 由 team 租户管理员创建，0..n 成员（`workspacemembers`）；
 * - global 名称恒「全局工作区」、不可改名/删除、无成员行（语义=租户全员）；
 * - **不挂作用域插件**（F6 裁决），查询一律显式条件。
 */
const workspaceSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: WORKSPACE_TYPES, required: true, default: 'normal' },
    // normal 记录创建者（admin）；global 为 null
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

workspaceSchema.index({ tenantId: 1, name: 1 }, { unique: true });
// 每租户恰一个全局工作区（Mongo 不支持对 $eq 外的表达式建部分索引，type 为枚举标量可直接匹配）
workspaceSchema.index(
  { tenantId: 1 },
  { unique: true, name: 'uniq_global_workspace_per_tenant', partialFilterExpression: { type: 'global' } },
);

export const Workspace = mongoose.model('Workspace', workspaceSchema);
export type IWorkspace = mongoose.InferSchemaType<typeof workspaceSchema>;
