import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true, index: true },
  controllerName: { type: String, required: true },
  acpServerType: { type: String, enum: ['opencode', 'github_copilot'], required: true },
  status: { type: String, enum: ['creating', 'connecting', 'idling', 'running', 'disconnected', 'ended'], default: 'creating' },
  title: { type: String, default: 'New Session' },
  externalSessionId: { type: String },
  cwd: { type: String },
  worktreePath: { type: String },
  worktreeBranch: { type: String },
  endedAt: { type: Date },
  modes: { type: [{ id: String, name: String, description: String }], default: [] },
  currentModeId: { type: String },
  currentModel: { type: { id: String, name: String, provider: String } },
  currentModelId: { type: String },
  availableModels: { type: [{ id: String, name: String, provider: String }], default: [] },
  permissionTimeoutAction: { type: String, enum: ['use_global', 'allow_once', 'reject', 'cancel'], default: 'use_global' },
}, { timestamps: true });

sessionSchema.index({ userId: 1, createdAt: -1 });
sessionSchema.index({ controllerId: 1, status: 1 });

export const Session = mongoose.model('Session', sessionSchema);
export type ISession = mongoose.InferSchemaType<typeof sessionSchema>;