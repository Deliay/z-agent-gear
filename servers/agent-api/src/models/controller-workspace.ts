import mongoose from 'mongoose';

const controllerWorkspaceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true, index: true },
  name: { type: String, required: true },
  path: { type: String, required: true },
  isEnabled: { type: Boolean, default: true },
}, { timestamps: true });

controllerWorkspaceSchema.index({ userId: 1, controllerId: 1 });

export const ControllerWorkspace = mongoose.model('ControllerWorkspace', controllerWorkspaceSchema);
export type IControllerWorkspace = mongoose.InferSchemaType<typeof controllerWorkspaceSchema>;
