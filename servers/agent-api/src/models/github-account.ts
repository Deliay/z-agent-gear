import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';
import { applyWorkspaceScope } from '../services/workspace-scope.js';

const githubAccountSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  tenantId: { type: String, required: true, index: true },
  // 多租户二期（F8）：workspaceId 对齐既有 tenantId 的 String 口径（= workspace._id.toString()）
  workspaceId: { type: String, default: null, index: true },
  githubUserId: { type: Number, required: true },
  githubLogin: { type: String, required: true },
  githubAvatarUrl: { type: String },
  accessToken: { type: String, required: true },
  tokenExpiresAt: { type: Date },
}, { timestamps: true });

// 多租户二期：唯一索引由 `{tenantId,userId,githubUserId}` 切换为 `{tenantId,workspaceId,githubUserId}`
// （userId 保留为创建者；旧索引由迁移 015 删除）。
githubAccountSchema.index(
  { tenantId: 1, workspaceId: 1, githubUserId: 1 },
  { unique: true, name: 'uniq_github_account_tenant_workspace_user' },
);

applyTenantScope(githubAccountSchema);
// 共享型资源：读 = 当前工作区 ∪ 本租户全局；写仅当前工作区
applyWorkspaceScope(githubAccountSchema, { shared: true });

export const GitHubAccount = mongoose.model('GitHubAccount', githubAccountSchema);
export type IGitHubAccount = mongoose.InferSchemaType<typeof githubAccountSchema>;
