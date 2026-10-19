import mongoose from 'mongoose';

export const BILLING_LEDGER_POOLS = ['cash', 'gift', 'credit'] as const;
export const BILLING_LEDGER_ALLOCATION_POOLS = ['cash', 'gift', 'credit'] as const;
export const BILLING_LEDGER_BIZ_TYPES = [
  'recharge',
  'charge',
  'freeze',
  'unfreeze',
  'settle',
  'adjust',
] as const;

/** 资金流水（不可变、只增不删）：资金真相，wallet 缓存与 ledger 累加的差即对账对象。 */
const billingLedgerSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    pool: { type: String, enum: BILLING_LEDGER_POOLS, required: true },
    bizType: { type: String, enum: BILLING_LEDGER_BIZ_TYPES, required: true },
    deltaBalance: { type: Number, default: 0 },
    deltaFrozen: { type: Number, default: 0 },
    // 拆池明细（现金/赠送/授信）；deltaBalance 为各池合计，保证对账口径一致
    allocations: {
      type: [
        new mongoose.Schema(
          {
            pool: { type: String, enum: BILLING_LEDGER_POOLS, required: true },
            amount: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    bizId: { type: String, default: null },
    idempotentKey: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'billingledgers' },
);

billingLedgerSchema.index({ accountId: 1, createdAt: -1 });

/** 追加式不可变：任何 update/delete 一律拒绝（更正只能新增 adjust 条目）。 */
function rejectMutation(next: (err?: Error) => void): void {
  next(new Error('billingledgers is append-only; update/delete is forbidden'));
}
billingLedgerSchema.pre('updateOne', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});
billingLedgerSchema.pre('updateMany', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});
billingLedgerSchema.pre('findOneAndUpdate', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});
billingLedgerSchema.pre('deleteOne', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});
billingLedgerSchema.pre('deleteMany', function (this: unknown, next: any) {
  next(new Error('append-only; update/delete is forbidden'));
});

export const BillingLedger = mongoose.model('BillingLedger', billingLedgerSchema);
export type IBillingLedger = mongoose.InferSchemaType<typeof billingLedgerSchema>;
