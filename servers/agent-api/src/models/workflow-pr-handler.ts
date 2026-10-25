import mongoose from 'mongoose';

/** 注销原因（供日志与排查；记录落库前删除，不单独持久化） */
export const PR_HANDLER_UNREGISTER_REASONS = [
  'WORKFLOW_FINISHED',
  'ARCHIVED',
  'DELETED',
  'REPLACED',
  'STALE',
] as const;
export type PrHandlerUnregisterReason = (typeof PR_HANDLER_UNREGISTER_REASONS)[number];

const workflowPrHandlerSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    workflowInstanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkflowInstance', required: true },
    nodeId: { type: String, required: true },
    nodeKey: { type: String, default: null },
    // 归一化 owner/repo#number（保留原始大小写）
    pullRequestId: { type: String, required: true },
    // 小写归一（事件入口精确匹配走索引，避免大小写不敏感 regex 全表扫描）
    pullRequestIdLower: { type: String, required: true },
    prUrl: { type: String, default: null },
    registeredBySessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null },
    // 最近已处理事件 ID（幂等位）
    lastEventId: { type: String, default: null },
    lastEventAt: { type: Date, default: null },
    // ---- Check Runs 同步状态（只读投影；存量行为 null 等价「从未同步」） ----
    // 上次写入 check-run 的 commit（需求口径「记录上次写入的 commit」）
    lastWrittenCommitSha: { type: String, default: null },
    // 当前有效 check-run id（PATCH 目标；非空 = 当前提交曾写入检查项）
    lastCheckRunId: { type: Number, default: null },
    // 最近写入的 check-run 页面地址
    lastCheckRunUrl: { type: String, default: null },
    // 最近已同步的节点状态（幂等比对）
    lastSyncedNodeStatus: { type: String, default: null },
    // 最近同步时间
    lastSyncAt: { type: Date, default: null },
    // 最近失败短文案（成功时清空；截断 200 字符）
    lastSyncError: { type: String, default: null },
    // 最近一次 todo 渲染内容的 sha1（内容未变跳过写入）
    lastTodoDigest: { type: String, default: null },
  },
  { timestamps: true },
);

// 事件入口按 PR 查登记
workflowPrHandlerSchema.index({ pullRequestId: 1 });
// 事件入口大小写不敏感精确匹配（小写归一列）
workflowPrHandlerSchema.index({ pullRequestIdLower: 1 });
// 实例联动列表 / 注销
workflowPrHandlerSchema.index({ workflowInstanceId: 1 });
// 并发注册兜底
workflowPrHandlerSchema.index(
  { workflowInstanceId: 1, nodeId: 1, pullRequestId: 1 },
  { unique: true, name: 'uniq_workflow_pr_handler' },
);

export const WorkflowPrHandler = mongoose.model('WorkflowPrHandler', workflowPrHandlerSchema);
export type IWorkflowPrHandler = mongoose.InferSchemaType<typeof workflowPrHandlerSchema>;
