import mongoose from 'mongoose';

const gatewaySchema = new mongoose.Schema({
  controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true },
  port: { type: Number, required: true, min: 1, max: 65535 },
  status: { type: String, enum: ['active', 'inactive', 'error'], default: 'active' },
}, { timestamps: true });

gatewaySchema.index({ controllerId: 1, name: 1 }, { unique: true });
gatewaySchema.index({ userId: 1 });
gatewaySchema.index({ controllerId: 1, status: 1 });

const GatewayModel = mongoose.model('Gateway', gatewaySchema, 'gateways');
export { GatewayModel as Gateway };
export type IGateway = mongoose.InferSchemaType<typeof gatewaySchema>;
