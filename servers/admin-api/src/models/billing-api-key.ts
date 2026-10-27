import mongoose from 'mongoose';
import { BILLING_OWNER_TYPES } from './billing-account.js';

/**
 * API Key：完整明文仅生成时返回一次，库内仅存前缀 + bcrypt 哈希。
 *
 * scope：
 * - `account`：用户设置页生成的通用 Key（行为与历史一致，无有效期）。
 * - `cloud_host`：云电脑运行专用 Key，绑定 `cloudHostId`（CloudHost._id），**随容器回收**：
 *   不写固定有效期；网关鉴权实时校验宿主状态，停止/失败/删除时撤销（见 billing-key-auth）。
 */
const billingApiKeySchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    // 枚举统一收口 `BILLING_OWNER_TYPES`（F5：此前内联枚举未复用常量）
    ownerType: { type: String, enum: BILLING_OWNER_TYPES, required: true },
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    keyPrefix: { type: String, required: true, index: true },
    keyHash: { type: String, required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },
    scope: { type: String, enum: ['account', 'cloud_host'], default: 'account', index: true },
    // 云电脑 ID（CloudHost._id）；仅 scope=cloud_host 时非空
    cloudHostId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    // 历史遗留有效期（已废弃）：云电脑 Key 随容器回收，新 Key 恒为 null；保留字段兼容旧数据
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
  },
  { collection: 'billingapikeys', timestamps: true },
);

billingApiKeySchema.index({ scope: 1, cloudHostId: 1, status: 1 });

export const BillingApiKey = mongoose.model('BillingApiKey', billingApiKeySchema);
export type IBillingApiKey = mongoose.InferSchemaType<typeof billingApiKeySchema>;
