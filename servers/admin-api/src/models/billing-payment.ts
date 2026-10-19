import mongoose from 'mongoose';

const poolAllocationSchema = new mongoose.Schema(
  {
    pool: { type: String, enum: ['cash', 'gift', 'credit', 'frozen'], required: true },
    amount: { type: Number, required: true },
  },
  { _id: false },
);

/** 支付记录：一次账单的拆池扣款结果；`idempotentKey` 唯一保证重放安全。 */
const billingPaymentSchema = new mongoose.Schema(
  {
    invoiceId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    amount: { type: Number, required: true },
    pools: { type: [poolAllocationSchema], default: [] },
    releasedFrozen: { type: Number, default: 0 },
    status: { type: String, enum: ['succeeded', 'failed'], default: 'succeeded' },
    idempotentKey: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'billingpayments' },
);

export const BillingPayment = mongoose.model('BillingPayment', billingPaymentSchema);
export type IBillingPayment = mongoose.InferSchemaType<typeof billingPaymentSchema>;
