import mongoose from 'mongoose';

/** 模型调用记录（灰度/中断/估算/费用回溯用）。 */
const billingApiCallSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, unique: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    apiKeyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // 云电脑 Key 调用归因；账号 Key 为 null
    cloudHostId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    // false = 自定义模型代转发（不计费，仅调用审计）
    billable: { type: Boolean, default: true },
    modelId: { type: String, required: true },
    modelName: { type: String, default: '' },
    inputTokens: { type: Number, default: 0 },
    cachedInputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['started', 'completed', 'aborted', 'failed'],
      default: 'started',
    },
    invoiceSeq: { type: Number, default: null },
    estimated: { type: Boolean, default: false },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
  },
  { collection: 'billingapicalls', timestamps: false },
);

export const BillingApiCall = mongoose.model('BillingApiCall', billingApiCallSchema);
export type IBillingApiCall = mongoose.InferSchemaType<typeof billingApiCallSchema>;
