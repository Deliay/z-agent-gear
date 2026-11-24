import mongoose from 'mongoose';

/**
 * 云电脑规格计费游标（`cloudbillingcursors`）：admin-api 独占写。
 *
 * 一个容器一条（`resourceId` = 容器 id，与 `billingreservations.resourceId` 同口径）；
 * 承载已结算分钟数与尾段收口状态，不回写其他服务的集合。结构对齐 `storagebillingcursors`。
 */
const cloudBillingCursorSchema = new mongoose.Schema(
  {
    resourceId: { type: String, required: true },
    hostId: { type: String, default: null },
    hostName: { type: String, default: null },
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true },
    tenantId: { type: String, default: null },
    // 规格快照（计费资源量；不随规格表变更）
    specId: { type: String, default: null },
    specName: { type: String, default: null },
    specCpu: { type: Number, required: true },
    specMemoryGi: { type: Number, required: true },
    specEphemeralStorageGi: { type: Number, required: true },
    // 桶锚点（= container.ready 的 billingStartedAt）
    billingStartedAt: { type: Date, required: true },
    // 已结算分钟数（整桶按 60 推进，尾段按实际分钟）
    chargedMinutes: { type: Number, default: 0 },
    lastChargedAt: { type: Date, default: null },
    // 销毁事件时刻（收到 container.destroyed 时写入）；非空即待尾段结算，供 tick 重试兜底。
    destroyedAt: { type: Date, default: null },
    // 销毁尾段结算完成（之后不再扫描）
    closedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { collection: 'cloudbillingcursors', timestamps: true },
);

cloudBillingCursorSchema.index({ resourceId: 1 }, { unique: true });
cloudBillingCursorSchema.index({ closedAt: 1, lastChargedAt: 1 });

export const CloudBillingCursor = mongoose.model(
  'CloudBillingCursor',
  cloudBillingCursorSchema,
);
export type ICloudBillingCursor = mongoose.InferSchemaType<typeof cloudBillingCursorSchema>;
