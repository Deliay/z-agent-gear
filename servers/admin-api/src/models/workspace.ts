import mongoose from 'mongoose';

/**
 * 租户工作区只读镜像（集合名与 agent-api 的 `workspaces` 严格对齐）。
 *
 * 与 agent-api 同步演进，只读镜像：单一事实源在 agent-api（`workspace-service`）——
 * 本模型仅供后台租户详情的工作区只读视图，admin-api 不创建、不更新、不删除。
 *
 * 口径（多租户二期）：
 * - 每租户恰一个 `type='global'`（部分唯一索引 `uniq_global_workspace_per_tenant`）；
 * - global 名称恒「全局工作区」、不可改名/删除、无成员行（语义=租户全员）；
 * - **不挂作用域插件**（agent-api 侧 F6 裁决），后台查询一律显式 `{tenantId}` 条件。
 */
const workspaceSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['global', 'normal'], required: true, default: 'normal' },
    // normal 记录创建者（admin）；global 为 null
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

workspaceSchema.index({ tenantId: 1, name: 1 }, { unique: true });
// 每租户恰一个全局工作区（与 agent-api 索引声明同名同 spec，autoIndex 幂等）
workspaceSchema.index(
  { tenantId: 1 },
  {
    unique: true,
    name: 'uniq_global_workspace_per_tenant',
    partialFilterExpression: { type: 'global' },
  },
);

export const Workspace = mongoose.model('Workspace', workspaceSchema);
export type IWorkspace = mongoose.InferSchemaType<typeof workspaceSchema>;
