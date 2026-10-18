import mongoose from 'mongoose';

export const INVOICE_TYPES = ['charge', 'recharge', 'adjust'] as const;
export const INVOICE_CATEGORIES = ['container', 'model', 'manual'] as const;

const invoiceItemSchema = new mongoose.Schema(
  {
    productId: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    amount: { type: Number, required: true },
    meteringRef: { type: String, default: null },
    /** 模型分段（input / cached_input / output）；容器为 null。 */
    segment: { type: String, default: null },
  },
  { _id: false },
);

/**
 * 账单明细（追加式不可变）：`{accountId, seq}` 唯一，seq 从 0 连续递增。
 * amount 为整数分：充值为正、消费为负。
 */
const billingInvoiceSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    seq: { type: Number, required: true },
    type: { type: String, enum: INVOICE_TYPES, required: true },
    category: { type: String, enum: INVOICE_CATEGORIES, required: true },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    refType: { type: String, default: null },
    refId: { type: String, default: null },
    // 出账幂等键（唯一稀疏索引）：重放/并发不会重复开票
    idempotentKey: { type: String, default: null, unique: true, sparse: true },
    description: { type: String, default: '' },
    items: { type: [invoiceItemSchema], default: [] },
    receiptId: { type: mongoose.Schema.Types.ObjectId, default: null },
    periodFrom: { type: Date, default: null },
    periodTo: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'billinginvoices' },
);

billingInvoiceSchema.index({ accountId: 1, seq: 1 }, { unique: true });

function rejectMutation(next: (err?: Error) => void): void {
  next(new Error('billinginvoices is append-only; update/delete is forbidden'));
}
billingInvoiceSchema.pre('updateOne', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});
billingInvoiceSchema.pre('updateMany', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});
billingInvoiceSchema.pre('findOneAndUpdate', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});
billingInvoiceSchema.pre('deleteOne', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});
billingInvoiceSchema.pre('deleteMany', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});

export const BillingInvoice = mongoose.model('BillingInvoice', billingInvoiceSchema);
export type IBillingInvoice = mongoose.InferSchemaType<typeof billingInvoiceSchema>;
