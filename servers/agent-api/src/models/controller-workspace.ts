import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

const controllerWorkspaceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true, index: true },
  name: { type: String, required: true },
  path: { type: String, required: true },
  isEnabled: { type: Boolean, default: true },
  isGitRepo: { type: Boolean, default: null },
  defaultBranch: { type: String, default: null },
}, { timestamps: true });

controllerWorkspaceSchema.index({ userId: 1, controllerId: 1 });

applyTenantScope(controllerWorkspaceSchema);

export const ControllerWorkspace = mongoose.model('ControllerWorkspace', controllerWorkspaceSchema);
export type IControllerWorkspace = mongoose.InferSchemaType<typeof controllerWorkspaceSchema>;
