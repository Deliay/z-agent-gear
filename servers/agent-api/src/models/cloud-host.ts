import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';
import { applyWorkspaceScope } from '../services/workspace-scope.js';

export const CLOUD_HOST_STATUSES = [
  'STARTING',
  'RUNNING',
  'STOPPING',
  'STOPPED',
  'FAILED',
] as const;

export type CloudHostStatus = (typeof CLOUD_HOST_STATUSES)[number];

export const HARNESS_TYPES = ['OPENCODE', 'KIMI_CODE', 'DEEPSEEK_HARNESS'] as const;

export type HarnessType = (typeof HARNESS_TYPES)[number];

/**
 * 前台云电脑（集合 `cloudhosts`）。
 *
 * 生命周期：创建即启动 → 停止即销毁。`status` 是云电脑生命周期的唯一事实源；
 * `STARTING/RUNNING/STOPPING` 为活跃态，`STOPPED/FAILED` 为终态。数量无限制（PRD v1.0）。
 * `deletedAt` 非空表示软删除（列表隐藏，Controller/会话/消息留档）。
 */
const cloudHostSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    harnessTypes: {
      type: [String],
      enum: HARNESS_TYPES,
      default: [],
    },
    status: {
      type: String,
      enum: CLOUD_HOST_STATUSES,
      default: 'STARTING',
      index: true,
    },
    controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true, index: true },
    keyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ControllerKey', required: true },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ControllerWorkspace',
      required: false,
      default: null,
    },
    // 多租户二期（计划期裁决，对齐 F1 命名口径）：`workspaceId` 已为「项目工作区
    // （ControllerWorkspace）」语义并被默认工作区链路强消费，租户工作区维度改用
    // `resourceWorkspaceId`；契约 `CloudHost.workspaceId` 由 resolver 映射本字段。
    resourceWorkspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: false,
      default: null,
      index: true,
    },
    containerId: { type: String, default: null },
    defaultSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null },
    // 锁定的 Github 帐号；null=未选定（创建时可选定，或首次 Git 项目设置时 CAS 绑定一次）
    githubAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'GitHubAccount',
      required: false,
      default: null,
    },
    // D1：创建时是否由 ready 回调自动建默认会话；历史行缺省视为 true（零迁移）
    createDefaultSession: { type: Boolean, default: true },
    startedAt: { type: Date, default: null },
    readyAt: { type: Date, default: null },
    stoppedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  { collection: 'cloudhosts', timestamps: true },
);

cloudHostSchema.index({ userId: 1, status: 1 });
cloudHostSchema.index({ controllerId: 1 });
// A-5（PRD v1.0）：数量无限制；活跃唯一索引 uniq_active_cloud_host_per_user
// 已由迁移 011 下线（迁移 005 只读不回改），此处不得再声明。

applyTenantScope(cloudHostSchema);
// 多租户二期：独占型资源，租户工作区维度为 `resourceWorkspaceId`（计划期裁决，对齐 F1）
applyWorkspaceScope(cloudHostSchema, { workspaceField: 'resourceWorkspaceId' });

export const CloudHost = mongoose.model('CloudHost', cloudHostSchema);
export type ICloudHost = mongoose.InferSchemaType<typeof cloudHostSchema>;
