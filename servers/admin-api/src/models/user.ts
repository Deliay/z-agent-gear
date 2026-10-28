import mongoose from 'mongoose';

/**
 * 前台用户只读镜像（集合名与 agent-api 的 `users` 严格对齐）。
 *
 * 单一事实源在 agent-api——本模型**仅供后台租户/成员只读查询**，admin-api 不创建、不更新、不删除。
 * 三层帐号模型：`tenantId` 承载 tenant→users 一对多、`accountId` 承载 account→users 一对多；
 * 原登录字段 `username/passwordHash` 一期暂保留（迁移只复制不删除）。
 * 与 agent-api **同步演进**（字段变更必须双服务同 PR）。
 */
const userSchema = new mongoose.Schema(
  {
    // 展示名（迁移后=原用户名）
    name: { type: String, default: '' },
    // 所属租户（一期 personal 恒等于 _id）
    tenantId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    // 登录账户关联
    accountId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    // 原登录字段：一期保留、运行时不再使用（后续期次下线）
    username: { type: String, default: '' },
    passwordHash: { type: String, default: '' },
    globalPermissionTimeoutAction: {
      type: String,
      enum: ['allow_once', 'reject', 'cancel'],
      default: 'allow_once',
    },
  },
  { collection: 'users', timestamps: true },
);

export const User = mongoose.model('User', userSchema);
export type IUser = mongoose.InferSchemaType<typeof userSchema>;
