import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';
import { applyWorkspaceScope } from '../services/workspace-scope.js';

/** 提交人模式（DB 小写字面量；GraphQL 侧为大写枚举）。 */
export const COMMITTER_MODES = ['agent_only', 'co_author', 'human_only', 'unset'] as const;
export type CommitterMode = (typeof COMMITTER_MODES)[number];

/** 提交人类型（DB 小写字面量；GraphQL 侧为大写枚举）。 */
export const COMMITTER_TYPES = ['github_account', 'custom', 'unset'] as const;
export type CommitterType = (typeof COMMITTER_TYPES)[number];

/**
 * 工作区级 Commit 设置（集合 `user_commit_settings`，仅对云容器环境生效）。
 *
 * 多租户二期（D10）：键由 userId 改 `workspaceId`（每工作区一行，String 口径对齐既有 tenantId）；
 * `userId` 降级为「最近编辑者」审计字段（保留、不再唯一）。
 * 唯一索引 `{workspaceId}` 由迁移 015 显式创建（`uniq_workspace_commit_setting`），
 * 旧 `userId` 唯一 / `{tenantId,userId}` 唯一 / `uniq_user_commit_setting` 由迁移删除。
 */
const userCommitSettingSchema = new mongoose.Schema(
  {
    // userId 仅作「最近编辑者」审计字段（多租户二期 D10），不再建索引：
    // 旧的 `userId_1` / `uniq_user_commit_setting` 由迁移 011/015 清理，
    // 字段级 index 会与迁移的固定索引名冲突（IndexOptionsConflict）。
    userId: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },
    // 多租户二期（F8）：String 口径；唯一索引由迁移 015 建固定名，
    // 这里不再声明字段级 index，避免自动生成 `workspaceId_1` 与之冲突。
    workspaceId: { type: String, required: false, default: null },
    committerMode: {
      type: String,
      enum: COMMITTER_MODES,
      default: 'unset',
    },
    committerType: {
      type: String,
      enum: COMMITTER_TYPES,
      default: 'unset',
    },
    githubAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'GitHubAccount',
      default: null,
    },
    customName: { type: String, default: null, maxlength: 100 },
    customEmail: { type: String, default: null, maxlength: 254 },
  },
  { collection: 'user_commit_settings', timestamps: true },
);

// 多租户二期（F4）：键改 workspaceId 唯一（迁移 015 以固定名创建后再删旧唯一索引）
userCommitSettingSchema.index({ workspaceId: 1 }, { unique: true, name: 'uniq_workspace_commit_setting' });

applyTenantScope(userCommitSettingSchema);
applyWorkspaceScope(userCommitSettingSchema);

export const UserCommitSetting = mongoose.model('UserCommitSetting', userCommitSettingSchema);
export type IUserCommitSetting = mongoose.InferSchemaType<typeof userCommitSettingSchema>;
