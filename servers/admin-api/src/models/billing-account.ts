import mongoose from 'mongoose';

export const BILLING_OWNER_TYPES = ['front_user', 'admin_user'] as const;
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
    invoiceSeq: { type: Number, default: 0 },
    status: { type: String, enum: BILLING_ACCOUNT_STATUSES, default: 'active' },
    insufficientSince: { type: Date, default: null },
  },
  { collection: 'billingaccounts', timestamps: true },
);

billingAccountSchema.index({ ownerType: 1, ownerId: 1 }, { unique: true });

export const BillingAccount = mongoose.model('BillingAccount', billingAccountSchema);
export type IBillingAccount = mongoose.InferSchemaType<typeof billingAccountSchema>;
