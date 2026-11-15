// 后台管理员外部身份绑定（集合 `adminexternallogins`，admin-api 唯一写方）
import mongoose from 'mongoose';

/**
 * 管理员外部身份绑定关系（`adminexternallogins`）。
 *
 * - `{providerId, issuer, subject}` 唯一：同一外部身份只能绑定一名管理员；
 * - `{adminUserId, providerId}` 唯一：每管理员每 provider 一条；
 * - 绑定关系是后台第三方登录的**授权前提**（未绑定一律 NOT_BOUND，杜绝 IdP 任意用户自动获得管理员权限）。
 */
const adminExternalLoginSchema = new mongoose.Schema(
  {
    adminUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', required: true, index: true },
    providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'AuthProvider', required: true },
    // OIDC 身份命名空间；github_oauth 为空
    issuer: { type: String, default: null },
    subject: { type: String, required: true },
    externalUsername: { type: String, required: true },
    displayName: { type: String, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { collection: 'adminexternallogins', timestamps: true },
);

adminExternalLoginSchema.index(
  { providerId: 1, issuer: 1, subject: 1 },
  { unique: true, name: 'uniq_admin_external_login_subject' },
);
adminExternalLoginSchema.index(
  { adminUserId: 1, providerId: 1 },
  { unique: true, name: 'uniq_admin_external_login_admin_provider' },
);

export const AdminExternalLogin = mongoose.model('AdminExternalLogin', adminExternalLoginSchema);
export type IAdminExternalLogin = mongoose.InferSchemaType<typeof adminExternalLoginSchema>;
