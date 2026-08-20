import mongoose from 'mongoose';
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
    // 展示顺序（仅影响 UI 排列，不影响执行顺序）
    sortOrder: { type: Number, default: undefined },
  },
  { _id: false },
);

const workflowInstanceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ControllerWorkspace', required: true },
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
  },
  { timestamps: true },
);

workflowInstanceSchema.index({ userId: 1, workspaceId: 1, createdAt: -1 });
workflowInstanceSchema.index({ configuredWorkflowId: 1 });

export const WorkflowInstance = mongoose.model('WorkflowInstance', workflowInstanceSchema);
export type IWorkflowInstance = mongoose.InferSchemaType<typeof workflowInstanceSchema>;
