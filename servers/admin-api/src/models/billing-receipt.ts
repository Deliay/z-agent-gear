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

function rejectMutation(next: (err?: Error) => void): void {
  next(new Error('billingreceipts is append-only; update/delete is forbidden'));
}
billingReceiptSchema.pre('updateOne', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});
billingReceiptSchema.pre('updateMany', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});
billingReceiptSchema.pre('findOneAndUpdate', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});
billingReceiptSchema.pre('deleteOne', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});
billingReceiptSchema.pre('deleteMany', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});

export const BillingReceipt = mongoose.model('BillingReceipt', billingReceiptSchema);
export type IBillingReceipt = mongoose.InferSchemaType<typeof billingReceiptSchema>;
