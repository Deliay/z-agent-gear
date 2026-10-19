import mongoose from 'mongoose';

/**
 * 钱包应用标记（A-2）：`{accountId, ledgerId}` 唯一，**不淘汰**。
 *
 * 账户文档上的 `appliedLedgerIds` 水位只保留最近 N 条（控制文档体积），水位被 `$slice`
 * 淘汰后不能再用它判断「该 ledger 是否已应用到钱包」。本集合记录每一条 ledger 的应用状态：
 * - `walletApplied=false`：已插入标记但钱包更新尚未完成（崩溃窗口）；
 * - `walletApplied=true`：钱包更新已完成。
 *
 * 不变量：**任何一次钱包应用之前必先写入本集合标记**。因此「无标记 ⇒ 从未应用」是安全的，
 * 重放（at-least-once / resetCursor / DLQ 重放）不会因为水位淘汰而二次记账。
 */
const billingAppliedLedgerSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    ledgerId: { type: String, required: true },
    walletApplied: { type: Boolean, default: false },
    appliedAt: { type: Date, default: null },
  },
  { collection: 'billingappliedledgers', timestamps: false },
);

billingAppliedLedgerSchema.index({ accountId: 1, ledgerId: 1 }, { unique: true });

export const BillingAppliedLedger = mongoose.model(
  'BillingAppliedLedger',
  billingAppliedLedgerSchema,
);
export type IBillingAppliedLedger = mongoose.InferSchemaType<typeof billingAppliedLedgerSchema>;
