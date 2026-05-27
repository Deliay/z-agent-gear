import mongoose from 'mongoose';

const portForwardSchema = new mongoose.Schema({
  controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  port: { type: Number, required: true, min: 1, max: 65535 },
  status: { type: String, enum: ['active', 'inactive', 'error'], default: 'active' },
}, { timestamps: true });

portForwardSchema.index({ controllerId: 1, port: 1 }, { unique: true });
portForwardSchema.index({ userId: 1 });
portForwardSchema.index({ controllerId: 1, status: 1 });

export const PortForward = mongoose.model('PortForward', portForwardSchema);
export type IPortForward = mongoose.InferSchemaType<typeof portForwardSchema>;
