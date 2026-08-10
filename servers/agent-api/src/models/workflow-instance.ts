import mongoose from 'mongoose';
import { WORKFLOW_NODE_TYPES } from './workflow-template.js';

export const WORKFLOW_NODE_STATUSES = ['INITIALIZING', 'READY', 'RUNNING', 'DONE', 'REJECT', 'REWORK', 'FAILED'] as const;
export type WorkflowNodeStatus = (typeof WORKFLOW_NODE_STATUSES)[number];

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
  },
  { _id: false },
);

const workflowInstanceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ControllerWorkspace', required: true },
    configuredWorkflowId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConfiguredWorkflow', required: true },
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
  },
  { timestamps: true },
);

workflowInstanceSchema.index({ userId: 1, workspaceId: 1, createdAt: -1 });
workflowInstanceSchema.index({ configuredWorkflowId: 1 });

export const WorkflowInstance = mongoose.model('WorkflowInstance', workflowInstanceSchema);
export type IWorkflowInstance = mongoose.InferSchemaType<typeof workflowInstanceSchema>;
