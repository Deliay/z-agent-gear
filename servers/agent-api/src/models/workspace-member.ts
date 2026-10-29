import mongoose from 'mongoose';

/**
 * 工作区成员（集合 `workspacemembers`，多租户二期）。
 *
 * - `{workspaceId,userId}` 唯一；冗余 `tenantId` 便于「成员须为本租户成员」校验与级联清理；
 * - **global 工作区恒无成员行**（语义=租户全员，避免成员变更双写）；
 * - admin 不依赖本集合（所有工作区对 admin 可见），本集合仅约束 developer；
 * - **不挂作用域插件**（F6 裁决），查询一律显式 `{workspaceId,userId}`。
 */
const workspaceMemberSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { collection: 'workspacemembers', timestamps: true },
);

workspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

export const WorkspaceMember = mongoose.model('WorkspaceMember', workspaceMemberSchema);
export type IWorkspaceMember = mongoose.InferSchemaType<typeof workspaceMemberSchema>;
