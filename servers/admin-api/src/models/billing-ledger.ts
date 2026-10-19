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
    /**
     * 可观测性标记（非正确性来源）：钱包同步的恰好一次由独立幂等集合
     * `billingappliedledgers`（`{accountId, ledgerId}` 唯一 + 租约，**不淘汰**）保证；
     * 账户文档的 `appliedLedgerIds` 只是最近 1000 条的辅助水位（会被 `$slice` 淘汰），
     * **不能**独立作为幂等依据（见 `payment.applyLedgerDelta`）。本字段仅在该行同步成功后由
     * best-effort 写入，供排查使用；**不得**据此判断是否需要补做钱包更新。
     */
    walletApplied: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'billingledgers' },
);

billingLedgerSchema.index({ accountId: 1, createdAt: -1 });

/** 追加式不可变：任何 update/delete/replace/bulkWrite 一律拒绝（更正只能新增 adjust 条目）。 */
const APPEND_ONLY_MESSAGE = 'billingledgers is append-only; update/delete is forbidden';
type AppendOnlySchema = {
  pre: (method: string, fn: (this: unknown, next: (err?: Error) => void) => void) => unknown;
};
const appendOnlySchema = billingLedgerSchema as unknown as AppendOnlySchema;
function blockMutation(this: unknown, next: (err?: Error) => void): void {
  next(new Error(APPEND_ONLY_MESSAGE));
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
  appendOnlySchema.pre(method, blockMutation);
}

// A10：query 级 pre hook 覆盖不到 `load → save` 路径，这里显式拦截对已存在文档的 save。
type SaveGuardSchema = {
  pre: (method: string, fn: (this: { isNew: boolean }) => void) => unknown;
};
(billingLedgerSchema as unknown as SaveGuardSchema).pre('save', function () {
  if (!this.isNew) throw new Error(APPEND_ONLY_MESSAGE);
});

export const BillingLedger = mongoose.model('BillingLedger', billingLedgerSchema);
export type IBillingLedger = mongoose.InferSchemaType<typeof billingLedgerSchema>;
