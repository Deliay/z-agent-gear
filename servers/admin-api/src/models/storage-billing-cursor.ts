import mongoose from 'mongoose';

/**
 * 存储计费进度游标（`storagebillingcursors`）：admin-api 独占写。
 *
 * 遵循「写方单一」：已结算到第几个小时由本集合承载，不回写 agent-api 的 `cloudstorages`。
 */
const storageBillingCursorSchema = new mongoose.Schema(
  {
    storageId: { type: mongoose.Schema.Types.ObjectId, required: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // 容量快照（容量不可变，快照仅防镜像异常）
    sizeGi: { type: Number, required: true },
    billingStartedAt: { type: Date, required: true },
    // 已结算小时数
    chargedHours: { type: Number, default: 0 },
    // 最近一次出账费率（排查用）
    lastRate: { type: String, enum: ['FULL', 'HALF'], default: null },
    lastChargedAt: { type: Date, default: null },
    // 存储销毁后的尾段结算完成时间
    closedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { collection: 'storagebillingcursors', timestamps: true },
);

storageBillingCursorSchema.index({ storageId: 1 }, { unique: true });
storageBillingCursorSchema.index({ closedAt: 1 });

export const StorageBillingCursor = mongoose.model(
  'StorageBillingCursor',
  storageBillingCursorSchema,
);
export type IStorageBillingCursor = mongoose.InferSchemaType<typeof storageBillingCursorSchema>;
