import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

/** 提交人类型（DB 小写字面量；GraphQL 侧为大写枚举）。 */
export const COMMITTER_TYPES = ['custom', 'unset'] as const;
export type CommitterType = (typeof COMMITTER_TYPES)[number];

/**
 * 成员级提交人设置（集合 `user_commit_settings`，仅对云容器环境生效）。
 *
 * 键回归 `userId`（每个成员一份，团队内成员相互独立、无共享/继承）；
 * 唯一索引 `uniq_user_commit_setting`（`{userId:1}`）由迁移 019 以「先建后删」方式创建，
 * 旧 `uniq_workspace_commit_setting` 由同一迁移删除。
 *
 * `tenantId` 仅作成员所属租户留档，不参与业务查询过滤；
 * 查询一律以显式 `userId` 点查（不读取 ALS 工作区上下文），因此移除 `applyWorkspaceScope`，
 * 保留 `applyTenantScope` 以满足多租户隔离不变量。
 */
const userCommitSettingSchema = new mongoose.Schema(
  {
    // 成员归属（唯一键）；旧的 workspaceId 键与三段继承已下线（迁移 019 重键）
    userId: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },
    committerType: {
      type: String,
      enum: COMMITTER_TYPES,
      default: 'unset',
    },
    customName: { type: String, default: null, maxlength: 100 },
    customEmail: { type: String, default: null, maxlength: 254 },
  },
  { collection: 'user_commit_settings', timestamps: true },
);

// 迁移 019 以固定名「先建后删」切换索引；这里声明同名字段不重复建索引，
// 避免 Mongoose autoIndex 生成 `userId_1` 与迁移固定名冲突（ensureIndex 兼容处理）。
userCommitSettingSchema.index({ userId: 1 }, { unique: true, name: 'uniq_user_commit_setting' });

applyTenantScope(userCommitSettingSchema);

export const UserCommitSetting = mongoose.model('UserCommitSetting', userCommitSettingSchema);
export type IUserCommitSetting = mongoose.InferSchemaType<typeof userCommitSettingSchema>;
