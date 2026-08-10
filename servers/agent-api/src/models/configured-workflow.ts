import mongoose from 'mongoose';
import { WORKFLOW_NODE_TYPES } from './workflow-template.js';

// 注意：agentConfig 使用独立子 Schema 声明，避免内联嵌套对象被 Mongoose 物化为 {}
//（HUMAN/FLAG 节点的 agentConfig 必须保持为 null/undefined）
const agentNodeConfigSchema = new mongoose.Schema(
  {
    acpServerType: { type: String, required: true },
    modeId: { type: String },
    modelId: { type: String },
    initNewWorktree: { type: Boolean, default: false },
  },
  { _id: false },
);

const configuredNodeSchema = new mongoose.Schema(
  {
    nodeKey: { type: String, required: true },
    type: { type: String, enum: WORKFLOW_NODE_TYPES, required: true },
    name: { type: String, required: true },
    description: { type: String },
    stage: { type: String, required: true },
    prompts: { type: [String], default: undefined },
    artifactTitles: { type: [String], default: undefined },
    dependsOn: { type: [String], default: [] },
    requiresWorktree: { type: Boolean, default: false },
    // AI 节点必填；HUMAN/FLAG 节点为 null
    agentConfig: { type: agentNodeConfigSchema, default: undefined },
  },
  { _id: false },
);

const configuredWorkflowSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true },
    name: { type: String, required: true },
    // 复制来源（仅展示用，无强关联；模板后续更新不影响本副本）
    sourceTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkflowTemplate' },
    sourceTemplateVersion: { type: Number },
    nodes: { type: [configuredNodeSchema], default: [] },
  },
  { timestamps: true },
);

configuredWorkflowSchema.index({ userId: 1, controllerId: 1 });

export const ConfiguredWorkflow = mongoose.model('ConfiguredWorkflow', configuredWorkflowSchema);
export type IConfiguredWorkflow = mongoose.InferSchemaType<typeof configuredWorkflowSchema>;
