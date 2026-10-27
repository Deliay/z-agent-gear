import mongoose from 'mongoose';

export const METERING_RESOURCE_TYPES = ['container', 'model', 'cloud_host'] as const;

/** 计量事实（可重放、可复核）：用量不因调价改变。 */
const meteringRecordSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    accountId: { type: String, required: true, index: true },
    resourceType: { type: String, enum: METERING_RESOURCE_TYPES, required: true },
    resourceId: { type: String, required: true },
    productId: { type: String, required: true, index: true },
    quantity: { type: Number, required: true },
    dims: { type: mongoose.Schema.Types.Mixed, default: {} },
    windowFrom: { type: Date, required: true },
    windowTo: { type: Date, required: true },
    estimated: { type: Boolean, default: false },
    // R8-1：`invoiced` 仅被开票路径写入（创建时 false，`BillingService.invoiceExistingCharge`
    // 成功后置 true），**全仓无读取点**，不参与计费/开票/收据/对账判定。它**不是**可用的
    // 「出账游标」——`MeteringService.resetCursor` 只重置 `BillingEvent.metered`，
    // 没有 `invoiced` 的重置/重扫路径。
    invoiced: { type: Boolean, default: false, index: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'meteringrecords' },
);

export const MeteringRecord = mongoose.model('MeteringRecord', meteringRecordSchema);
export type IMeteringRecord = mongoose.InferSchemaType<typeof meteringRecordSchema>;
