import mongoose from 'mongoose';

/** 业务事件事实层（不可变语义）：只描述发生了什么，不携带金额。 */
const billingEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    eventType: { type: String, required: true, index: true },
    occurredAt: { type: Date, required: true },
    accountId: { type: String, required: true, index: true },
    resourceId: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    metered: { type: Boolean, default: false, index: true },
    receivedAt: { type: Date, default: Date.now },
  },
  { collection: 'billingevents', timestamps: false },
);

export const BillingEvent = mongoose.model('BillingEvent', billingEventSchema);
export type IBillingEvent = mongoose.InferSchemaType<typeof billingEventSchema>;
