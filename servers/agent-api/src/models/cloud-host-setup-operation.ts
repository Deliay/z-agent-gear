import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

export const CLOUD_HOST_SETUP_KINDS = ['installWorkload', 'githubSetup'] as const;
export type CloudHostSetupKind = (typeof CLOUD_HOST_SETUP_KINDS)[number];

export const CLOUD_HOST_SETUP_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export type CloudHostSetupStatus = (typeof CLOUD_HOST_SETUP_STATUSES)[number];

export const CLOUD_HOST_SETUP_STEP_KEYS = ['workload', 'gitSetup', 'session'] as const;
export type CloudHostSetupStepKey = (typeof CLOUD_HOST_SETUP_STEP_KEYS)[number];

export const CLOUD_HOST_SETUP_STEP_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
] as const;
export type CloudHostSetupStepStatus = (typeof CLOUD_HOST_SETUP_STEP_STATUSES)[number];

const setupStepSchema = new mongoose.Schema(
  {
    key: { type: String, enum: CLOUD_HOST_SETUP_STEP_KEYS, required: true },
    status: { type: String, enum: CLOUD_HOST_SETUP_STEP_STATUSES, default: 'PENDING' },
    detail: { type: String, default: null },
  },
  { _id: false },
);

/**
 * 云主机设置操作状态机（集合 `cloud_host_setup_operations`）。
 * 安装工作负载与 Github 项目设置共用；操作创建后立即返回，后台异步推进。
 */
const cloudHostSetupOperationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true, index: true },
    hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'CloudHost', required: true, index: true },
    kind: { type: String, enum: CLOUD_HOST_SETUP_KINDS, required: true },
    status: { type: String, enum: CLOUD_HOST_SETUP_STATUSES, default: 'RUNNING' },
    /** installWorkload 目标工作负载与参数（内部字段，不暴露 GraphQL）。 */
    workloadId: { type: mongoose.Schema.Types.ObjectId, default: null },
    installParams: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** githubSetup 绑定参数（内部字段，不暴露 GraphQL）。 */
    accountId: { type: mongoose.Schema.Types.ObjectId, default: null },
    repoFullName: { type: String, default: null },
    targetPath: { type: String, default: null },
    /** githubSetup 额外选择安装的工作负载 ID（Github 固定安装，不在此列）。 */
    setupWorkloadIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    steps: { type: [setupStepSchema], default: [] },
    batchId: { type: String, default: null },
    containerId: { type: String, default: null },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', default: null },
    error: { type: String, default: null },
  },
  { collection: 'cloud_host_setup_operations', timestamps: true },
);

cloudHostSetupOperationSchema.index({ userId: 1, createdAt: -1 });
cloudHostSetupOperationSchema.index({ controllerId: 1, status: 1 });

applyTenantScope(cloudHostSetupOperationSchema);

export const CloudHostSetupOperation = mongoose.model('CloudHostSetupOperation', cloudHostSetupOperationSchema);
export type ICloudHostSetupOperation = mongoose.InferSchemaType<
  typeof cloudHostSetupOperationSchema
>;
