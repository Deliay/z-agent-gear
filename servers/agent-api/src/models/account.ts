import mongoose from 'mongoose';

/**
 * 登录账户（集合 `accounts`）。
 *
 * 三层帐号模型第一层：承载登录凭据（username/passwordHash）。
 * - 不引用 User（account→users 为一对多，关联由 `users.accountId` 承载）；
 * - username 唯一索引即登录名唯一性的唯一裁决面（users.username 一期仅保留不下线）；
 * - 写方仅 agent-api（`/internal/users` 开户），admin-api 只读镜像。
 */
const accountSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, minlength: 2, maxlength: 20 },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true },
);

export const Account = mongoose.model('Account', accountSchema);
export type IAccount = mongoose.InferSchemaType<typeof accountSchema>;
