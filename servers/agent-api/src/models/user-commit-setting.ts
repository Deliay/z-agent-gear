import mongoose from 'mongoose';

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
 * **不挂任何作用域插件**（既无 `applyWorkspaceScope` 也无 `applyTenantScope`）：
 * - 键是全局成员标识 `userId`，`tenantId` 仅为「成员归属租户」留档（写入时取 `users.tenantId`），
 *   **不作业务过滤条件**（实现计划「关键约束 / 裁决 3」）；
 * - `applyTenantScope` 会在查询编译期把 `tenantId` 注入为当前 ALS 工作区租户
 *   （`getWorkspaceContext()?.tenantId`），导致同一成员在团队工作区保存 / 在个人工作区读取时
 *   互相不可见，甚至 upsert 撞唯一索引后回读落空而静默丢失——与「成员独立、任何工作区同一份」矛盾；
 * - 跨租户泄漏风险不成立：`userId` 本身是全局唯一主键，不存在同 userId 分属不同租户的情形；
 *   T-ISO 矩阵（`models/tenant-isolation.test.ts`）对该集合显式豁免并断言「不注入 tenantId」。
 */
const userCommitSettingSchema = new mongoose.Schema(
  {
    // 成员归属（唯一键）；旧的 workspaceId 键与三段继承已下线（迁移 019 重键）
    userId: { type: String, required: true },
    // 成员所属租户（留档，不参与查询过滤）
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

export const UserCommitSetting = mongoose.model('UserCommitSetting', userCommitSettingSchema);
export type IUserCommitSetting = mongoose.InferSchemaType<typeof userCommitSettingSchema>;
