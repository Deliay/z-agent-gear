// 与 servers/agent-api/src/models/auth-provider.ts 同步演进（admin-api 为唯一写方）
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
 * 第三方登录配置（集合 `authproviders`）。
 *
 * - **唯一写方 admin-api**；agent-api 只读镜像（OAuth 授权/回调消费）。
 * - `clientSecret` 以 AES-256-GCM 加密落库（复用 services/crypto.ts + CREDENTIAL_ENCRYPTION_KEY），
 *   一切出参恒不含明文/密文（以 `hasSecret` 代替）。
 * - `github_oauth` 全平台仅一条：`{type:1}` 部分唯一索引（partialFilterExpression `{type:'github_oauth'}`）。
 * - `enabled` 默认 false（创建后显式启用，避免半成品暴露到登录页）；
 *   后台登录默认关闭（`enableAdminLogin=false`），显式开启。
 */
const authProviderSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, enum: AUTH_PROVIDER_TYPES },
    displayName: { type: String, required: true, trim: true },
    // OIDC 必填；github_oauth 恒为空
    issuer: { type: String, default: null },
    clientId: { type: String, required: true },
    encryptedClientSecret: { type: encryptedClientSecretSchema, required: true },
    // OIDC scopes（空格分隔）；github_oauth 不使用
    scopes: { type: String, default: null },
    enabled: { type: Boolean, default: false },
    enableFrontLogin: { type: Boolean, default: true },
    enableAdminLogin: { type: Boolean, default: false },
  },
  { collection: 'authproviders', timestamps: true },
);

// github_oauth 单条（部分唯一）；与迁移 022 固定名逐字一致
authProviderSchema.index(
  { type: 1 },
  {
    unique: true,
    name: 'uniq_auth_provider_github',
    partialFilterExpression: { type: 'github_oauth' },
  },
);
// 登录页查询：按类型 + 启用状态
authProviderSchema.index({ type: 1, enabled: 1 }, { name: 'auth_provider_type_enabled' });

export const AuthProvider = mongoose.model('AuthProvider', authProviderSchema);
export type IAuthProvider = mongoose.InferSchemaType<typeof authProviderSchema>;
