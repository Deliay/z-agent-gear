import mongoose from 'mongoose';

export const RESERVATION_STATUSES = [
  'PENDING',
  'ACTIVE',
  'SETTLING',
  'SETTLED',
  'RELEASE_PENDING',
] as const;

const billingReservationSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    resourceId: { type: String, required: true, index: true },
    resourceType: { type: String, enum: ['container'], default: 'container' },
    productId: { type: String, default: 'container.minute' },
    status: { type: String, enum: RESERVATION_STATUSES, default: 'PENDING', index: true },
    /** 保证金（分）。 */
    depositCents: { type: Number, default: 0 },
    /** 每周期预估冻结（分）。 */
    cycleEstimateCents: { type: Number, default: 0 },
    reservedTotal: { type: Number, default: 0 },
    settledTotal: { type: Number, default: 0 },
    releasedTotal: { type: Number, default: 0 },
    /** 已结算到的窗口起点。 */
    lastSettleAt: { type: Date, required: true },
    lastCycleSeq: { type: Number, default: 0 },
    startedAt: { type: Date, required: true },
    expectedEndAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  { collection: 'billingreservations', timestamps: true },
);

export const BillingReservation = mongoose.model('BillingReservation', billingReservationSchema);
export type IBillingReservation = mongoose.InferSchemaType<typeof billingReservationSchema>;

/** 周期结算记录：`{reservationId, cycleSeq}` 唯一，保证重复消息无副作用。 */
const billingReservationCycleSchema = new mongoose.Schema(
  {
    reservationId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    cycleSeq: { type: Number, required: true },
    windowFrom: { type: Date, required: true },
    windowTo: { type: Date, required: true },
    minutes: { type: Number, required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ['settled', 'skipped'], default: 'settled' },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'billingreservationcycles' },
);

billingReservationCycleSchema.index({ reservationId: 1, cycleSeq: 1 }, { unique: true });

export const BillingReservationCycle = mongoose.model(
  'BillingReservationCycle',
  billingReservationCycleSchema,
);
export type IBillingReservationCycle = mongoose.InferSchemaType<
  typeof billingReservationCycleSchema
>;
