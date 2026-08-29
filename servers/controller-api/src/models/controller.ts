import mongoose from 'mongoose';

const controllerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, default: '' },
  hostname: { type: String, required: true },
  type: { type: String, enum: ['local', 'cloud', 'github'], required: true },
  status: { type: String, enum: ['online', 'offline', 'registering', 'unbound'], default: 'registering' },
  keyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ControllerKey', required: true, unique: true },
  version: { type: String, required: true },
  homeDir: { type: String },
  platform: { type: String },
  lastHeartbeatAt: { type: Date },
  lastIp: { type: String },
}, { timestamps: true });

controllerSchema.index({ userId: 1, status: 1 });
controllerSchema.index({ keyId: 1 }, { unique: true });

export const Controller = mongoose.model('Controller', controllerSchema);
export type IController = mongoose.InferSchemaType<typeof controllerSchema>;
