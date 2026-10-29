import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';
import { applyWorkspaceScope } from '../services/workspace-scope.js';

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
    // 人类节点：是否联动上游 Pull Request（仅 HUMAN 可为 true）
    linkUpstreamPullRequest: { type: Boolean, default: false },
    // 展示顺序（仅影响 UI 排列，不影响执行顺序）
    sortOrder: { type: Number, default: undefined },
  },
  { _id: false },
);

const workflowTemplateSchema = new mongoose.Schema(
  {
    // 可空：null 表示内置模板（isBuiltin=true）
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    // 系统内置模板 userId 为空（无归属），tenantId 跟随可选（迁移 013 只清洗带 userId 行）。
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    name: { type: String, required: true },
    // 多租户二期（F1）：租户工作区维度用 `resourceWorkspaceId`（`workspaceId` 属项目工作区语义）；
    // 系统内置模板（isBuiltin=true）恒 null，全工作区可见可用。
    resourceWorkspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: false,
      default: null,
      index: true,
    },
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

applyTenantScope(workflowTemplateSchema);
// 多租户二期（F9）：内置模板例外全局可见
applyWorkspaceScope(workflowTemplateSchema, {
  workspaceField: 'resourceWorkspaceId',
  builtinVisible: true,
});

export const WorkflowTemplate = mongoose.model('WorkflowTemplate', workflowTemplateSchema);
export type IWorkflowTemplate = mongoose.InferSchemaType<typeof workflowTemplateSchema>;
