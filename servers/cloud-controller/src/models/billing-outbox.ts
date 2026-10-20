import mongoose from 'mongoose';

/**
 * 计费事件 outbox（与 admin-api 共享集合 `billingoutbox`，字段严格对齐）。
 *
 * 可靠投递四层组合的第一层：业务侧先本地落库，再由进程内 relay 经 RabbitMQ
 * publisher confirm 发布；发布失败保留 `published=false` 供下一轮重试。
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
    /** 原子认领租约（R2，与 admin-api 语义一致）：多副本 relay 只有认领成功者发布。 */
    claimedAt: { type: Date, default: null, index: true },
    claimedBy: { type: String, default: null },
    /** 超过重试上限的毒消息隔离标记（不再无限重投）。 */
    failed: { type: Boolean, default: false, index: true },
    /**
     * R3-2：代偿补投行的来源事件 id（仅 admin-api 反向对账补投的 `…:repair:<ts>` 行写入）。
     * 与 admin-api schema 严格对齐，避免读取侧字段缺失。
     */
    repairOf: { type: String, default: null, index: true },
    createdAt: { type: Date, default: Date.now },
    publishedAt: { type: Date, default: null },
  },
  { collection: 'billingoutbox', timestamps: false },
);

billingOutboxSchema.index({ producer: 1, published: 1, createdAt: 1 });

export const BillingOutbox = mongoose.model('BillingOutbox', billingOutboxSchema);
export type IBillingOutbox = mongoose.InferSchemaType<typeof billingOutboxSchema>;
