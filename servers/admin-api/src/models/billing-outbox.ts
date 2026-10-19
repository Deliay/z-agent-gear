import mongoose from 'mongoose';

/**
 * 计费事件 outbox（与 cloud-controller 共享集合 `billingoutbox`，字段严格对齐）。
 * 各服务 relay 只处理本服务 `producer` 的行，避免双 relay 重复发布。
 */
const billingOutboxSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    producer: { type: String, required: true, enum: ['cloud-controller', 'admin-api'], index: true },
    eventType: { type: String, required: true },
    routingKey: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    published: { type: Boolean, default: false, index: true },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    /** 原子认领租约（B4）：多副本 relay 只有认领成功者发布，避免双发。 */
    claimedAt: { type: Date, default: null, index: true },
    claimedBy: { type: String, default: null },
    /** 超过重试上限的毒消息隔离标记（不再无限重投）。 */
    failed: { type: Boolean, default: false, index: true },
    createdAt: { type: Date, default: Date.now },
    publishedAt: { type: Date, default: null },
  },
  { collection: 'billingoutbox', timestamps: false },
);

billingOutboxSchema.index({ producer: 1, published: 1, createdAt: 1 });

export const BillingOutbox = mongoose.model('BillingOutbox', billingOutboxSchema);
export type IBillingOutbox = mongoose.InferSchemaType<typeof billingOutboxSchema>;
