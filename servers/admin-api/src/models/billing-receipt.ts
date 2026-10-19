import mongoose from 'mongoose';

/** 收据（追加式不可变）：扣款完成凭据，含金额与支付后余额。 */
const billingReceiptSchema = new mongoose.Schema(
  {
    receiptNo: { type: String, required: true, unique: true },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, default: null },
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    issuedAt: { type: Date, default: Date.now },
  },
  { collection: 'billingreceipts' },
);

/** 追加式不可变：任何 update/delete/replace/bulkWrite 一律拒绝。 */
type AppendOnlyReceiptSchema = {
  pre: (method: string, fn: (this: unknown, next: (err?: Error) => void) => void) => unknown;
};
const appendOnlyReceiptSchema = billingReceiptSchema as unknown as AppendOnlyReceiptSchema;
function blockReceiptMutation(this: unknown, next: (err?: Error) => void): void {
  next(new Error('billingreceipts is append-only; update/delete is forbidden'));
}
for (const method of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'bulkWrite',
]) {
  appendOnlyReceiptSchema.pre(method, blockReceiptMutation);
}

export const BillingReceipt = mongoose.model('BillingReceipt', billingReceiptSchema);
export type IBillingReceipt = mongoose.InferSchemaType<typeof billingReceiptSchema>;
