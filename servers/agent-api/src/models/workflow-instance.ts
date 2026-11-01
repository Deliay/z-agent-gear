import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';
import { applyWorkspaceScope } from '../services/workspace-scope.js';
import { WORKFLOW_NODE_TYPES, WORKFLOW_CREATED_BY } from './workflow-template.js';

export const WORKFLOW_NODE_STATUSES = ['INITIALIZING', 'READY', 'RUNNING', 'DONE', 'REJECT', 'REWORK', 'FAILED'] as const;
export type WorkflowNodeStatus = (typeof WORKFLOW_NODE_STATUSES)[number];

const agentNodeConfigSchema = new mongoose.Schema(
  {
    acpServerType: { type: String, required: true },
    modeId: { type: String },
    modelId: { type: String },
    initNewWorktree: { type: Boolean, default: false },
  },
  { _id: false },
);

const rejectInfoSchema = new mongoose.Schema(
  {
    reason: { type: String, required: true },
    // 发起打回的节点 nodeId
    fromNodeId: { type: String },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const failInfoSchema = new mongoose.Schema(
  {
    reason: { type: String, required: true },
    // 失败来源：SESSION_STUCK（提醒后仍会停止）/ LLM_REPORTED（LLM 调用 failCurrentNode）
    source: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const instanceNodeSchema = new mongoose.Schema(
  {
    nodeId: { type: String, required: true },
    nodeKey: { type: String, required: true },
    type: { type: String, enum: WORKFLOW_NODE_TYPES, required: true },
    name: { type: String, required: true },
    description: { type: String },
    stage: { type: String, required: true },
    status: { type: String, enum: WORKFLOW_NODE_STATUSES, default: 'INITIALIZING' },
    // 上游实例节点 nodeId 列表（实例化时由 configuredWorkflow 的 nodeKey 依赖映射生成）
    dependsOn: { type: [String], default: [] },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
    createdAt: { type: Date, default: Date.now },
    startedAt: { type: Date },
    reworkedAt: { type: Date },
    reworkCount: { type: Number, default: 0 },
    // 会话兜底提示词是否已发送（每节点仅 1 次，防死循环）
    fallbackSent: { type: Boolean, default: false },
    rejectInfo: { type: rejectInfoSchema, default: undefined },
    failInfo: { type: failInfoSchema, default: undefined },
    // ---- 实例快照字段（实例化时从最终节点图复制；旧实例缺失时由 orchestrator 回退读配置） ----
    prompts: { type: [String], default: undefined },
    artifactTitles: { type: [String], default: undefined },
    // AI 节点 Agent 配置快照（HUMAN/FLAG 节点为 null/undefined）
    agentConfig: { type: agentNodeConfigSchema, default: undefined },
    requiresWorktree: { type: Boolean, default: undefined },
    // 人类节点：是否联动上游 Pull Request（实例快照，未开始的人类节点可编辑）
    linkUpstreamPullRequest: { type: Boolean, default: false },
    // 展示顺序（仅影响 UI 排列，不影响执行顺序）
    sortOrder: { type: Number, default: undefined },
  },
  { _id: false },
);

const workflowInstanceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true },
    // 项目工作区（ControllerWorkspace）id —— 既有语义，零改动
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ControllerWorkspace', required: true },
    // 多租户二期（F1）：租户工作区维度（继承自已配置工作流 / 实例化时当前工作区）
    resourceWorkspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: false,
      default: null,
      index: true,
    },
    configuredWorkflowId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConfiguredWorkflow', default: null },
    name: { type: String, required: true },
    nodes: { type: [instanceNodeSchema], default: [] },
    // 实例对外状态 = 全部 RUNNING 节点名（引擎每次转移后维护）
    currentNodeNames: { type: [String], default: [] },
    // 工作流黑板（产物 key：{nodeId}-{nodeName}-产物-{title}；打回记录 key：打回-{nodeId}-{序号}）
    blackboard: { type: Map, of: String, default: {} },
    // 黑板垃圾桶（remove 的 entry 挪入此处）
    blackboardTrash: { type: Map, of: String, default: {} },
    // 每个 key 的最后更新时间（供 BlackboardEntry.updatedAt 使用）
    blackboardUpdatedAt: { type: Map, of: Date, default: {} },
    // 工作流级追加提示词（key 去重；系统键 github-pr / github-pr-review）
    additionalPrompts: { type: Map, of: String, default: {} },
    // 工作流完成时间（全部节点 DONE 时由引擎一次性写入）
    finishedAt: { type: Date, default: null },
    // 软删除标记：删除实例时置为删除时间（实例数据保留，查询/引擎均排除）
    deletedAt: { type: Date, default: null },
    // 归档标记：归档仅移入「已归档」分组，不影响流程运转
    archivedAt: { type: Date, default: null },
    // 最后执行过的节点（实例对外状态展示；引擎每次转移按时间序更新）
    lastNodeName: { type: String, default: null },
    lastNodeStatus: { type: String, enum: WORKFLOW_NODE_STATUSES, default: null },
    // 工作流 Worktree 路径（createWorkflowWorktree=true 且 Git 工作区时存在）
    workflowWorktreePath: { type: String, default: undefined },
    // 工作流 Worktree 分支名（createWorkflowWorktree=true 且 Git 工作区时存在）
    workflowWorktreeBranch: { type: String, default: undefined },
    // Worktree 提交人快照（实例化时解析一次；null = 不下发，沿用容器级 bot）
    worktreeCommitterName: { type: String, default: null },
    worktreeCommitterEmail: { type: String, default: null },
    // 与 bot 共同提交（成员级开关在 Worktree 创建时的快照；null = 不追加共同作者）
    worktreeCoAuthorName: { type: String, default: null },
    worktreeCoAuthorEmail: { type: String, default: null },
    // Worktree 清理失败标记（deleteInstance 时清理失败，孤儿 worktree 需手动回收）
    worktreeCleanupFailed: { type: Boolean, default: false },
  },
  { timestamps: true },
);

workflowInstanceSchema.index({ userId: 1, workspaceId: 1, createdAt: -1 });
workflowInstanceSchema.index({ configuredWorkflowId: 1 });
// 跨工作区全量列表（活跃/归档分开查）
workflowInstanceSchema.index({ userId: 1, archivedAt: 1, createdAt: -1 });
// 按控制器过滤（controllerId 当前未单独建索引）
workflowInstanceSchema.index({ userId: 1, controllerId: 1, archivedAt: 1, createdAt: -1 });

applyTenantScope(workflowInstanceSchema);
applyWorkspaceScope(workflowInstanceSchema, { workspaceField: 'resourceWorkspaceId' });

export const WorkflowInstance = mongoose.model('WorkflowInstance', workflowInstanceSchema);
export type IWorkflowInstance = mongoose.InferSchemaType<typeof workflowInstanceSchema>;
