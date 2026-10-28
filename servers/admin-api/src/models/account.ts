import mongoose from 'mongoose';

/**
 * 登录账户只读镜像（集合名与 agent-api 的 `accounts` 严格对齐）。
 *
 * 单一事实源在 agent-api（含 `/internal/users` 开户）——本模型**仅供后台租户/成员只读查询**，
 * admin-api 不创建、不更新、不删除。字段口径与 `docs/engineering/proposals/20261027-feat-multi-tenant-phase1.md` §4.1 一致，
 * 与 agent-api **同步演进**（agent-api 模型字段变更必须双服务同 PR）。
 */
const accountSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
  },
  { collection: 'accounts', timestamps: true },
);

export const Account = mongoose.model('Account', accountSchema);
export type IAccount = mongoose.InferSchemaType<typeof accountSchema>;
