import mongoose from 'mongoose';

export const WORKFLOW_NODE_TYPES = ['HUMAN', 'AI', 'FLAG'] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

const templateNodeSchema = new mongoose.Schema(
  {
    nodeKey: { type: String, required: true },
    type: { type: String, enum: WORKFLOW_NODE_TYPES, required: true },
    name: { type: String, required: true },
    description: { type: String },
    stage: { type: String, required: true },
    // AI 节点提示词数组；HUMAN/FLAG 节点必须为空（default: undefined 避免物化为 []）
    prompts: { type: [String], default: undefined },
    // 预定义产物 title；仅 AI 节点允许
    artifactTitles: { type: [String], default: undefined },
    dependsOn: { type: [String], default: [] },
    requiresWorktree: { type: Boolean, default: false },
  },
  { _id: false },
);

const workflowTemplateSchema = new mongoose.Schema(
  {
    // 可空：null 表示内置模板（isBuiltin=true）
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    name: { type: String, required: true },
    description: { type: String },
    version: { type: Number, default: 1 },
    nodes: { type: [templateNodeSchema], default: [] },
    isBuiltin: { type: Boolean, default: false },
  },
  { timestamps: true },
);

workflowTemplateSchema.index({ userId: 1, createdAt: -1 });

export const WorkflowTemplate = mongoose.model('WorkflowTemplate', workflowTemplateSchema);
export type IWorkflowTemplate = mongoose.InferSchemaType<typeof workflowTemplateSchema>;
