import mongoose from 'mongoose';

/**
 * 用户（集合 `users`）——身份主体（三层帐号模型第二层）。
 *
 * - `accountId` → accounts（user→account n..1；account→users 一对多由 accountId 承载）；
 * - `tenantId` → tenants（user→tenant n..1；tenant→users 一对多由 tenantId 承载），
 *   personal 场景恒等于 `_id`；
 * - `username`/`passwordHash` 一期**保留不下线**：迁移 012 只复制到 accounts、不删除，
 *   运行时登录不再使用（login 走 accounts）。后续期次连同唯一索引一并移除。
 */
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, minlength: 2, maxlength: 20 },
  passwordHash: { type: String, required: true },
  /** 展示名（迁移后=原 username；`me`/`login` 经 User.name 暴露） */
  name: { type: String },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', index: true },
  globalPermissionTimeoutAction: { type: String, enum: ['allow_once', 'reject', 'cancel'], default: 'allow_once' },
}, { timestamps: true });

export const User = mongoose.model('User', userSchema);
export type IUser = mongoose.InferSchemaType<typeof userSchema>;
