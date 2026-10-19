import mongoose from 'mongoose';

// 与 servers/agent-api/src/models/model.ts 同步演进
const modelPricingSchema = new mongoose.Schema(
  {
    // 费用中心模型定价（便捷编辑视图）；价目真相在 productprices。
    // 金额一律整数「分」/百万 token（0.01 credits = 1 分）。
    inputPerMillion: { type: Number, default: 0 },
    cachedInputPerMillion: { type: Number, default: 0 },
    outputPerMillion: { type: Number, default: 0 },
    isBillable: { type: Boolean, default: true },
  },
  { _id: false },
);

const modelSchema = new mongoose.Schema({
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true, index: true },
  name: { type: String, required: true },
  isCustom: { type: Boolean, default: false },
  isEnabled: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
  scope: { type: String, enum: ['user', 'global'], default: 'user', index: true },
  pricing: { type: modelPricingSchema, default: null },
}, { timestamps: true });

modelSchema.index({ providerId: 1, name: 1 }, { unique: true });

export const Model = mongoose.model('Model', modelSchema);
export type IModel = mongoose.InferSchemaType<typeof modelSchema>;
