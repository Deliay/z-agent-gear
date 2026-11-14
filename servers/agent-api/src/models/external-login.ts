import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

const { Schema } = mongoose;

/**
 * 前台用户外部身份（集合 `externallogins`，agent-api 唯一写方）。
 *
 * - 身份锚点：`{providerId, issuer, subject}` 唯一（跨租户的全局身份，不含 tenantId 维度）；
 * - `tenantId` 声明 + `applyTenantScope`（新增带 userId 集合的双注册要求：
 *   `models/tenant-isolation.test.ts` 与迁移 013 的 `TENANT_ID_COLLECTIONS`）；
 * - OAuth 首次登录自动开户后落本集合；并发首登由唯一索引 E11000 回读既有行幂等。
 */
const externalLoginSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
    providerId: { type: Schema.Types.ObjectId, ref: 'AuthProvider', required: true },
    // OIDC 身份命名空间（issuer）；github_oauth 为空
    issuer: { type: String, default: null },
    subject: { type: String, required: true },
    externalUsername: { type: String, required: true },
    displayName: { type: String, default: null },
    avatarUrl: { type: String, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { collection: 'externallogins', timestamps: true },
);

externalLoginSchema.index(
  { providerId: 1, issuer: 1, subject: 1 },
  { unique: true, name: 'uniq_external_login_subject' },
);
externalLoginSchema.index({ userId: 1 }, { name: 'external_login_user' });

// 带 userId 集合：查询/写入自动注入 tenantId（personal 期 tenantId == userId）
applyTenantScope(externalLoginSchema);

export const ExternalLogin = mongoose.model('ExternalLogin', externalLoginSchema);
export type IExternalLogin = mongoose.InferSchemaType<typeof externalLoginSchema>;
