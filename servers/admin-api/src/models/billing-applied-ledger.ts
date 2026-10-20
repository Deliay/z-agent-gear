import mongoose from 'mongoose';

/**
 * 钱包应用标记（A-2）：`{accountId, ledgerId}` 唯一，**不淘汰**。
 *
 * 账户文档上的 `appliedLedgerIds` 水位只保留最近 N 条（控制文档体积），水位被 `$slice`
 * 淘汰后不能再用它判断「该 ledger 是否已应用到钱包」。本集合记录每一条 ledger 的应用状态：
 * - `walletApplied=false` + `claimedAt=null`：`pending`（已插入标记、尚未被任何一次同步认领）；
 * - `walletApplied=false` + `claimedAt!=null`：`in-flight`（某次同步已认领，租约内不得重复记账）；
 * - `walletApplied=false` + 租约过期：崩溃残留 → 接管后按 ledger 真值绝对校准（stale 自愈）；
 * - `walletApplied=true`：钱包更新已完成（终态，永不淘汰）。
 *
 * 不变量：**任何一次钱包应用之前必先写入本集合标记**。因此「无标记 ⇒ 从未应用」是安全的，
 * 重放（at-least-once / resetCursor / DLQ 重放）不会因为水位淘汰而二次记账。
 *
 * 注意：`claimedAt` **必须**在 schema 中显式声明——mongoose 严格模式会剥离非 schema 字段，
 * 缺字段会让 `claimedAt` 永不落库、租约 CAS 恒真、in-flight/stale 分支与自愈全部沦为死代码。
 */
const billingAppliedLedgerSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    ledgerId: { type: String, required: true },
    walletApplied: { type: Boolean, default: false },
    appliedAt: { type: Date, default: null },
    /** 同步租约认领时间（A-2）：in-flight/stale 判定的唯一依据，必须真实落库。 */
    claimedAt: { type: Date, default: null, index: true },
  },
  { collection: 'billingappliedledgers', timestamps: false },
);

billingAppliedLedgerSchema.index({ accountId: 1, ledgerId: 1 }, { unique: true });

export const BillingAppliedLedger = mongoose.model(
  'BillingAppliedLedger',
  billingAppliedLedgerSchema,
);
export type IBillingAppliedLedger = mongoose.InferSchemaType<typeof billingAppliedLedgerSchema>;
