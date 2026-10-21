import mongoose from 'mongoose';

/**
 * API Key：完整明文仅生成时返回一次，库内仅存前缀 + bcrypt 哈希。
 *
 * scope：
 * - `account`：用户设置页生成的通用 Key（行为与历史一致，无有效期）。
 * - `cloud_host`：云电脑运行专用 Key，绑定 `cloudHostId`（CloudHost._id）与 `expiresAt`；
 *   网关鉴权时实时校验宿主状态（见 billing-key-auth）。
 */
const billingApiKeySchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    ownerType: { type: String, enum: ['front_user', 'admin_user'], required: true },
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    keyPrefix: { type: String, required: true, index: true },
    keyHash: { type: String, required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },
    scope: { type: String, enum: ['account', 'cloud_host'], default: 'account', index: true },
    // 云电脑 ID（CloudHost._id）；仅 scope=cloud_host 时非空
    cloudHostId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    // 云电脑 Key 有效期（容器 TTL）；account Key 为 null
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
  },
  { collection: 'billingapikeys', timestamps: true },
);

billingApiKeySchema.index({ scope: 1, cloudHostId: 1, status: 1 });

export const BillingApiKey = mongoose.model('BillingApiKey', billingApiKeySchema);
export type IBillingApiKey = mongoose.InferSchemaType<typeof billingApiKeySchema>;
