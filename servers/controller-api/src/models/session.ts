import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

const configOptionSchema = new mongoose.Schema({
  id: String,
  name: String,
  description: String,
  category: String,
  type: String,
  currentValue: mongoose.Schema.Types.Mixed,
  options: [{ value: String, name: String }],
}, { _id: false });

const sessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true, index: true },
  controllerName: { type: String, required: true },
  acpServerType: { type: String, enum: ['opencode', 'github_copilot', 'claude_code', 'gemini_cli', 'codex', 'mimo_code', 'kimi_code', 'deepseek_harness'], required: true },
  status: { type: String, enum: ['creating', 'connecting', 'idling', 'running', 'disconnected', 'ended'], default: 'creating' },
  title: { type: String, default: 'New Session' },
  externalSessionId: { type: String },
  cwd: { type: String },
  endedAt: { type: Date },
  disconnectedAt: { type: Date },
  modes: { type: [{ id: String, name: String, description: String }], default: [] },
  currentModeId: { type: String },
  currentModel: { type: { id: String, name: String, provider: String } },
  currentModelId: { type: String },
  availableModels: { type: [{ id: String, name: String, provider: String }], default: [] },
  configOptions: { type: [configOptionSchema], default: [] },
  promptCapabilities: { type: { image: Boolean, audio: Boolean, embeddedContext: Boolean } },
  agentInfo: { type: { name: String, version: String } },
  authMethods: { type: [{ id: String, kind: String, description: String, url: String }], default: [] },
  authRequired: { type: Boolean, default: false },
  supportsAdditionalDirectories: { type: Boolean, default: false },
  // 能力快照（controller 上报原文；旧 controller 不上报时为 null）
  agentCapabilities: { type: mongoose.Schema.Types.Mixed },
  // 初始 mode/model 应用确认失败记录（acp:initial-config:result，全部 applied 时 $unset）
  initialConfigError: { type: { modeId: String, modelId: String, error: String, at: Date } },
  // 工作流打标（与 agent-api 同步的副本字段，两服务共享 Mongo）
  workflowInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkflowInstance' },
  workflowNodeId: { type: String },
}, { timestamps: true });

sessionSchema.index({ userId: 1, createdAt: -1 });
sessionSchema.index({ controllerId: 1, status: 1 });

applyTenantScope(sessionSchema);

export const Session = mongoose.model('Session', sessionSchema);
export type ISession = mongoose.InferSchemaType<typeof sessionSchema>;