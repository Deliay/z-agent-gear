import mongoose from 'mongoose';

/** API Key：完整明文仅生成时返回一次，库内仅存前缀 + bcrypt 哈希。 */
const billingApiKeySchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    ownerType: { type: String, enum: ['front_user', 'admin_user'], required: true },
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    keyPrefix: { type: String, required: true, index: true },
    keyHash: { type: String, required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },
    lastUsedAt: { type: Date, default: null },
  },
  { collection: 'billingapikeys', timestamps: true },
);

export const BillingApiKey = mongoose.model('BillingApiKey', billingApiKeySchema);
export type IBillingApiKey = mongoose.InferSchemaType<typeof billingApiKeySchema>;
