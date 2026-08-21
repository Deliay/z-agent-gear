import mongoose from 'mongoose';

export const WORKFLOW_NODE_TYPES = ['HUMAN', 'AI', 'FLAG'] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

export const WORKFLOW_CREATED_BY = ['HUMAN', 'AI'] as const;
export type WorkflowCreatedBy = (typeof WORKFLOW_CREATED_BY)[number];

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
    // 展示顺序（仅影响 UI 排列，不影响执行顺序）
    sortOrder: { type: Number, default: undefined },
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
    // 资源归属：HUMAN（默认，界面创建）/ AI（工作流管理工具集创建）
    createdBy: { type: String, enum: WORKFLOW_CREATED_BY, default: 'HUMAN' },
    createdBySessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null },
  },
  { timestamps: true },
);

workflowTemplateSchema.index({ userId: 1, createdAt: -1 });

export const WorkflowTemplate = mongoose.model('WorkflowTemplate', workflowTemplateSchema);
export type IWorkflowTemplate = mongoose.InferSchemaType<typeof workflowTemplateSchema>;
