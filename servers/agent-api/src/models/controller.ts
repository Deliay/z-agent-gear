import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';
import { applyWorkspaceScope } from '../services/workspace-scope.js';

const controllerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  // 多租户二期：租户工作区归属（控制器注册从 ControllerKey 继承；云电脑控制器继承云电脑）
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: false, default: null, index: true },
  name: { type: String, default: '' },
  hostname: { type: String, required: true },
  type: { type: String, enum: ['local', 'cloud', 'github'], required: true },
  status: { type: String, enum: ['online', 'offline', 'registering', 'unbound'], default: 'registering' },
  keyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ControllerKey', required: true, unique: true },
  version: { type: String, required: true },
  lastHeartbeatAt: { type: Date },
  lastIp: { type: String },
  worktreeDir: { type: String },
  homeDir: { type: String },
  platform: { type: String },
  // 新建会话默认注入的 MCP；历史行缺失该字段时由 resolver 归一为 { useAllEnabled: true, serverIds: [] }
  defaultMcp: {
    useAllEnabled: { type: Boolean, default: true },
    serverIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'McpServer' }],
  },
}, { timestamps: true });

controllerSchema.index({ userId: 1, status: 1 });
controllerSchema.index({ keyId: 1 }, { unique: true });

applyTenantScope(controllerSchema);
applyWorkspaceScope(controllerSchema);

export const Controller = mongoose.model('Controller', controllerSchema);
export type IController = mongoose.InferSchemaType<typeof controllerSchema>;
