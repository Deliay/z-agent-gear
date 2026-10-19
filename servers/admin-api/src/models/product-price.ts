import mongoose from 'mongoose';

export const PRICING_MODELS = ['per_unit', 'per_token'] as const;

/**
 * 价目表（定价单一真相）：`model.<modelId>.token` / `container.minute`。
 * 金额为整数「分」：`unitPrice` 为分/单位；`rates` 为分/百万 token。
 */
const productPriceSchema = new mongoose.Schema(
  {
    productId: { type: String, required: true, index: true },
    productName: { type: String, default: '' },
    pricingModel: { type: String, enum: PRICING_MODELS, default: 'per_unit' },
    unitPrice: { type: Number, default: 0 },
    rates: {
      inputPerMillion: { type: Number, default: 0 },
      cachedInputPerMillion: { type: Number, default: 0 },
      outputPerMillion: { type: Number, default: 0 },
    },
    isBillable: { type: Boolean, default: true },
    effectiveFrom: { type: Date, default: Date.now },
  },
  { collection: 'productprices', timestamps: true },
);

productPriceSchema.index({ productId: 1, effectiveFrom: -1 });

export const ProductPrice = mongoose.model('ProductPrice', productPriceSchema);
export type IProductPrice = mongoose.InferSchemaType<typeof productPriceSchema>;
