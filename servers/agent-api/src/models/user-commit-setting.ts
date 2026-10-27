import mongoose from 'mongoose';

/** 提交人模式（DB 小写字面量；GraphQL 侧为大写枚举）。 */
export const COMMITTER_MODES = ['agent_only', 'co_author', 'human_only', 'unset'] as const;
export type CommitterMode = (typeof COMMITTER_MODES)[number];

/** 提交人类型（DB 小写字面量；GraphQL 侧为大写枚举）。 */
export const COMMITTER_TYPES = ['github_account', 'custom', 'unset'] as const;
export type CommitterType = (typeof COMMITTER_TYPES)[number];

/**
 * 用户级 Commit 设置（集合 `user_commit_settings`，仅对云容器环境生效）。
 *
 * `userId` 对齐 `GitHubAccount.userId` 的 String 口径；按 userId upsert。
 * 唯一索引由迁移 `011-user-commit-settings-index` 显式创建（关闭 autoIndex 的部署兜底）。
 */
const userCommitSettingSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
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

userCommitSettingSchema.index({ userId: 1 }, { unique: true });

export const UserCommitSetting = mongoose.model('UserCommitSetting', userCommitSettingSchema);
export type IUserCommitSetting = mongoose.InferSchemaType<typeof userCommitSettingSchema>;
