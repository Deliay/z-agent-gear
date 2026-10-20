import mongoose from 'mongoose';

/** 死信留档：超次重试的消息落库，费用中心可见并可对账/重放。 */
const billingDeadLetterSchema = new mongoose.Schema(
  {
    queue: { type: String, required: true, index: true },
    routingKey: { type: String, required: true },
    eventId: { type: String, default: null, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    error: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'billingdeadletters' },
);

export const BillingDeadLetter = mongoose.model('BillingDeadLetter', billingDeadLetterSchema);
export type IBillingDeadLetter = mongoose.InferSchemaType<typeof billingDeadLetterSchema>;
