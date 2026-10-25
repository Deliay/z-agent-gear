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

export const CONTAINER_PURPOSES = [
  'idle',
  'harness',
  'admin-task',
  'workflow',
  'session',
] as const;

/** 可被 `/internal/containers` 启动的用途白名单（契约 A.2.2）。 */
export const STARTABLE_PURPOSES = ['idle', 'harness'] as const;

/** 本期支持的 harness 类型白名单。 */
export const SUPPORTED_HARNESS_TYPES = ['opencode'] as const;

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

/** 容器内已安装工作负载（只增不删，按 workloadId 去重并保留首次记录）。 */
export interface InstalledWorkloadEntry {
  workloadId: string;
  name: string;
  installedAt: Date;
  source: 'start' | 'user' | 'mcp';
}

const installedWorkloadSchema = new mongoose.Schema(
  {
    workloadId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    installedAt: { type: Date, required: true },
    source: { type: String, enum: ['start', 'user', 'mcp'], required: true },
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
    // 云电脑（purpose=harness）关联字段；历史记录缺失时读取层容忍为 null/[]
    hostId: { type: String, default: null, index: true },
    hostName: { type: String, default: null },
    harnessTypes: { type: [String], default: [] },
    controllerKeyId: { type: String, default: null },
    containerApiKeyId: { type: String, default: null },
    /** 云电脑最低 agent-gear 版本（max(服务端常量, 请求值)）；普通容器为 null。 */
    agentGearMinVersion: { type: String, default: null },
    /** 容器 TTL 到期时间（仅落库留存，供计费凭证到期等业务使用；不再映射 Job 硬截止）；历史记录为 null。 */
    expiresAt: { type: Date, default: null },
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
    // 计费归属（费用中心）：为空表示不计费（存量/未接入计费调用方）
    billingAccountId: { type: String, default: null },
    // 就绪计费起点：首次 markOnline 写入；重复 markOnline 不重置
    billingStartedAt: { type: Date, default: null },
    // 初始化中当前正在执行的工作负载脚本名称；非初始化中为 null
    currentWorkloadName: { type: String, default: null },
    // 容器内已安装工作负载（runtime 安装/起始 init 成功回填）；历史容器为空
    installedWorkloads: { type: [installedWorkloadSchema], default: [] },
    // 当前初始化批次来源：start（创建启动）/ runtime（在线安装）；用于收口判定与重连防重放
    initTrigger: { type: String, enum: ['start', 'runtime', null], default: null },
    // 起始初始化已收口（首次 online）时间：非空后断线重连不得再次执行 init 批次（工作流只初始化一次）
    initCompletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'cloudcontainers' },
);

export const CloudContainer = mongoose.model('CloudContainer', cloudContainerSchema);

export type ICloudContainer = mongoose.InferSchemaType<typeof cloudContainerSchema>;
