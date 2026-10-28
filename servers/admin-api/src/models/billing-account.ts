import mongoose from 'mongoose';

/**
 * 计费账户归属类型：
 * - `front_user` **已废弃**：存量前台行由迁移 014 转为 `tenant`（ownerId 不变），仅作历史兼容保留；
 *   运行时读请求在 route 层归一解析为同 ownerId 的 `tenant` 行，写请求不再接受该值。
 * - `admin_user`：后台账户计费，保持原样，与 `tenant` 并存（后台链路零改动）。
 * - `tenant`：前台租户计费账户（ownerId=tenantId，一期 personal 恒等于 userId）。
 */
export const BILLING_OWNER_TYPES = ['front_user', 'admin_user', 'tenant'] as const;
export type BillingOwnerType = (typeof BILLING_OWNER_TYPES)[number];

export const BILLING_ACCOUNT_STATUSES = ['active', 'frozen'] as const;
export type BillingAccountStatus = (typeof BILLING_ACCOUNT_STATUSES)[number];

/**
 * 钱包缓存 `billingaccounts`（资金真相在 `billingledgers`）。
 * 金额一律整数「分」（0.01 credits = 1 分）。
 */
const billingAccountSchema = new mongoose.Schema(
  {
    ownerType: { type: String, enum: BILLING_OWNER_TYPES, required: true },
    ownerId: { type: String, required: true },
    ownerName: { type: String, default: '' },
    cashBalance: { type: Number, default: 0 },
    giftBalance: { type: Number, default: 0 },
    creditLimit: { type: Number, default: 0 },
    frozenAmount: { type: Number, default: 0 },
    /**
     * 已应用到钱包的 ledger 行 ID 集合（R1：与余额在同一账户文档上原子推进的「水位」）。
     * 资金同步以 `{_id, appliedLedgerIds: {$ne: ledgerId}}` 为过滤做单条原子更新，
     * 保证「ledger 已落账但钱包可能未更新」的崩溃场景下，重放能补做且恰好一次。
     * 仅保留最近 N 条（更早的重放由对账兜底）。
     */
    appliedLedgerIds: { type: [String], default: [] },
    invoiceSeq: { type: Number, default: 0 },
    status: { type: String, enum: BILLING_ACCOUNT_STATUSES, default: 'active' },
    insufficientSince: { type: Date, default: null },
  },
  { collection: 'billingaccounts', timestamps: true },
);

billingAccountSchema.index({ ownerType: 1, ownerId: 1 }, { unique: true });

export const BillingAccount = mongoose.model('BillingAccount', billingAccountSchema);
export type IBillingAccount = mongoose.InferSchemaType<typeof billingAccountSchema>;
