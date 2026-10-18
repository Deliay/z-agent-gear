import mongoose from 'mongoose';

export const ROLLUP_GRANULARITIES = ['minute', 'hour', 'day'] as const;

/** 汇总缓存（reduce sum）：按分钟/小时/天预聚合，支撑秒级汇总视图。 */
const billingRollupSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    granularity: { type: String, enum: ROLLUP_GRANULARITIES, required: true },
    bucketStart: { type: Date, required: true },
    chargeTotal: { type: Number, default: 0 },
    rechargeTotal: { type: Number, default: 0 },
    chargeCount: { type: Number, default: 0 },
  },
  { collection: 'billingrollups' },
);

billingRollupSchema.index({ accountId: 1, granularity: 1, bucketStart: 1 }, { unique: true });

export const BillingRollup = mongoose.model('BillingRollup', billingRollupSchema);
export type IBillingRollup = mongoose.InferSchemaType<typeof billingRollupSchema>;
