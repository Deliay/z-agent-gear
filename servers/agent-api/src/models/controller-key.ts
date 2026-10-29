import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';
import { applyWorkspaceScope } from '../services/workspace-scope.js';

const controllerKeySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  // 多租户二期：创建 key 时的租户工作区（控制器注册从此继承）
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: false, default: null, index: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['local', 'cloud', 'github'], required: true },
  keyHash: { type: String, required: true, unique: true },
  keyPrefix: { type: String, required: true },
  status: { type: String, enum: ['active', 'revoked', 'expired'], default: 'active' },
  boundControllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', default: null },
  lastUsedAt: { type: Date },
}, { timestamps: true });

controllerKeySchema.index({ userId: 1, status: 1 });

applyTenantScope(controllerKeySchema);
applyWorkspaceScope(controllerKeySchema);

export const ControllerKey = mongoose.model('ControllerKey', controllerKeySchema);
export type IControllerKey = mongoose.InferSchemaType<typeof controllerKeySchema>;
