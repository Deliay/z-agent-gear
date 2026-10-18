import mongoose from 'mongoose';

export const CONTAINER_STATUSES = [
  'creating',
  'connecting',
  'initializing',
  'online',
  'exited',
  'destroying',
  'failed',
] as const;

export type CloudContainerStatus = (typeof CONTAINER_STATUSES)[number];

export const CONTAINER_PURPOSES = ['idle', 'admin-task', 'workflow', 'session'] as const;

export type CloudContainerPurpose = (typeof CONTAINER_PURPOSES)[number];

/**
 * 终态集合：进入这些状态后一次性 token 作废（契约 §3.1）。
 */
export const TERMINAL_STATUSES: readonly CloudContainerStatus[] = [
  'exited',
  'destroying',
  'failed',
];

export function isTerminalStatus(status: CloudContainerStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * 本次启动最终执行计划的一条：数组顺序即执行顺序（契约 A.2.2 / 提案 §4.1）。
 * `params` 为已归一（含默认值）的参数快照，`implicit` 标识该条是否为隐式依赖。
 */
export interface WorkloadPlanEntry {
  workloadId: string;
  params: Record<string, unknown>;
  implicit: boolean;
  /** 本次启动该条是否为「必须」；缺省 false（历史记录/旧调用）。 */
  required: boolean;
}

const workloadPlanEntrySchema = new mongoose.Schema(
  {
    workloadId: { type: mongoose.Schema.Types.ObjectId, required: true },
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    implicit: { type: Boolean, default: false },
    required: { type: Boolean, default: false },
  },
  { _id: false },
);

const cloudContainerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    namespace: { type: String, required: true },
    status: {
      type: String,
      enum: CONTAINER_STATUSES,
      default: 'creating',
      index: true,
    },
    purpose: { type: String, enum: CONTAINER_PURPOSES, required: true },
    refId: { type: String, default: null },
    userId: { type: String, default: null },
    tokenHash: { type: String, default: null },
    image: { type: String, required: true },
    connectedAt: { type: Date, default: null },
    exitedAt: { type: Date, default: null },
    exitReason: { type: String, default: null },
    workloadIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    workloadPlan: { type: [workloadPlanEntrySchema], default: [] },
    // 必须工作负载失败标记（工作负载三期）：置位后容器不得被收口为 online/connecting，
    // 且在注销未完成（forceDestroy 失败/在途）时由看门狗重试强制注销。
    mustFailure: { type: Boolean, default: false },
    currentWorkloadName: { type: String, default: null },
  },
  { timestamps: true, collection: 'cloudcontainers' },
);

export const CloudContainer = mongoose.model('CloudContainer', cloudContainerSchema);

export type ICloudContainer = mongoose.InferSchemaType<typeof cloudContainerSchema>;
