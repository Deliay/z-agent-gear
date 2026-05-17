import mongoose from 'mongoose';

const controllerKeySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['local', 'cloud', 'github'], required: true },
  keyHash: { type: String, required: true, unique: true },
  keyPrefix: { type: String, required: true },
  status: { type: String, enum: ['active', 'revoked', 'expired'], default: 'active' },
  boundControllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', default: null },
  lastUsedAt: { type: Date },
}, { timestamps: true });

controllerKeySchema.index({ userId: 1, status: 1 });

export const ControllerKey = mongoose.model('ControllerKey', controllerKeySchema);
export type IControllerKey = mongoose.InferSchemaType<typeof controllerKeySchema>;
