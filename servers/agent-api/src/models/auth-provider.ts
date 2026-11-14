// 与 servers/admin-api/src/models/auth-provider.ts 同步演进（本文件为只读镜像）
import mongoose from 'mongoose';

export const AUTH_PROVIDER_TYPES = ['oidc', 'github_oauth'] as const;
export type AuthProviderType = (typeof AUTH_PROVIDER_TYPES)[number];

const encryptedClientSecretSchema = new mongoose.Schema(
  {
    iv: { type: String, required: true },
    ciphertext: { type: String, required: true },
    tag: { type: String, required: true },
  },
  { _id: false },
);

/**
 * 第三方登录配置只读镜像（集合 `authproviders`，唯一写方为 admin-api）。
 *
 * 索引声明与 admin-api 模型 / 迁移 022 逐字一致；agent-api 侧只读，
 * 索引由 admin-api 迁移创建（本服务不重复建）。
 */
const authProviderSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, enum: AUTH_PROVIDER_TYPES },
    displayName: { type: String, required: true, trim: true },
    issuer: { type: String, default: null },
    clientId: { type: String, required: true },
    encryptedClientSecret: { type: encryptedClientSecretSchema, required: true },
    scopes: { type: String, default: null },
    enabled: { type: Boolean, default: false },
    enableFrontLogin: { type: Boolean, default: true },
    enableAdminLogin: { type: Boolean, default: false },
  },
  { collection: 'authproviders', timestamps: true },
);

authProviderSchema.index(
  { type: 1 },
  {
    unique: true,
    name: 'uniq_auth_provider_github',
    partialFilterExpression: { type: 'github_oauth' },
  },
);
authProviderSchema.index({ type: 1, enabled: 1 }, { name: 'auth_provider_type_enabled' });

export const AuthProvider = mongoose.model('AuthProvider', authProviderSchema);
export type IAuthProvider = mongoose.InferSchemaType<typeof authProviderSchema>;
