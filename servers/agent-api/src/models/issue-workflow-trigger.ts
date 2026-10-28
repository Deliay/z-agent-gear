import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

/** 触发记录状态机：工作区准备 → 实例化 → 等待并完成首个人类节点 → 完成/失败。 */
export const ISSUE_TRIGGER_STATUSES = [
  'PENDING_WORKSPACE',
  'PENDING_INSTANTIATE',
  'PENDING_HUMAN_NODE',
  'COMPLETED',
  'FAILED',
] as const;
export type IssueTriggerStatus = (typeof ISSUE_TRIGGER_STATUSES)[number];

/**
 * Issue 触发记录（集合 `issue_workflow_triggers`）。
 *
 * 唯一索引 `(controllerId, repoFullName, labelName, issueId)` 是
 * 「这个 Issue 对这条配置未曾创建过工作流」的权威幂等闸。
 * 快照字段保证配置删除后仍可继续推进/留档。
 */
const issueWorkflowTriggerSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true },
    /** 命中配置引用（配置删除后留档） */
    linkageId: { type: mongoose.Schema.Types.ObjectId, default: null },
    configuredWorkflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConfiguredWorkflow',
      required: true,
    },
    labelName: { type: String, required: true },
    repoFullName: { type: String, required: true },
    /** GitHub issue 数字 ID（字符串落库，幂等键组成部分） */
    issueId: { type: String, required: true },
    issueNumber: { type: Number, required: true },
    issueTitle: { type: String, required: true },
    issueUrl: { type: String, default: null },
    issueAuthor: { type: String, default: null },
    /** Issue 正文快照（首个人类节点输入用；≤64000） */
    issueBody: { type: String, default: null },
    status: { type: String, enum: ISSUE_TRIGGER_STATUSES, default: 'PENDING_WORKSPACE' },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ControllerWorkspace', default: null },
    setupOperationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    workflowInstanceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WorkflowInstance',
      default: null,
    },
    /** 待自动完成的首个人类节点 */
    humanNodeId: { type: String, default: null },
    /** 已完成的首个人类节点 */
    completedNodeId: { type: String, default: null },
    commentId: { type: Number, default: null },
    /** 回评尝试次数（失败后仅补偿一次） */
    commentAttempts: { type: Number, default: 0 },
    /** 回评失败原因（不阻断推进） */
    commentError: { type: String, default: null },
    failureReason: { type: String, default: null },
  },
  { collection: 'issue_workflow_triggers', timestamps: true },
);

// 幂等闸：同一 Issue 对同一（云电脑 × 仓库 × 标签）只触发一次
issueWorkflowTriggerSchema.index(
  { controllerId: 1, repoFullName: 1, labelName: 1, issueId: 1 },
  { unique: true, name: 'uniq_issue_workflow_trigger' },
);
// 启动扫描 / 定时恢复
issueWorkflowTriggerSchema.index({ controllerId: 1, status: 1 });
issueWorkflowTriggerSchema.index({ status: 1, updatedAt: -1 });

applyTenantScope(issueWorkflowTriggerSchema);

export const IssueWorkflowTrigger = mongoose.model('IssueWorkflowTrigger', issueWorkflowTriggerSchema);
export type IIssueWorkflowTrigger = mongoose.InferSchemaType<typeof issueWorkflowTriggerSchema>;
