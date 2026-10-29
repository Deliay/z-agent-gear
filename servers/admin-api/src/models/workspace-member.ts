import mongoose from 'mongoose';

/**
 * 工作区成员只读镜像（集合名与 agent-api 的 `workspacemembers` 严格对齐）。
 *
 * 与 agent-api 同步演进，只读镜像：单一事实源在 agent-api（`workspace-service`）——
 * 本模型仅供后台工作区成员数只读聚合，admin-api 不创建、不更新、不删除。
 *
 * 口径（多租户二期）：
 * - `{workspaceId,userId}` 唯一；冗余 `tenantId` 便于校验与级联清理；
 * - **global 工作区恒无成员行**（语义=租户全员，后台 memberCount 取租户成员数）；
 * - **不挂作用域插件**（agent-api 侧 F6 裁决），后台查询一律显式 `{workspaceId}` 条件。
 */
const workspaceMemberSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { collection: 'workspacemembers', timestamps: true },
);

workspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

export const WorkspaceMember = mongoose.model('WorkspaceMember', workspaceMemberSchema);
export type IWorkspaceMember = mongoose.InferSchemaType<typeof workspaceMemberSchema>;
