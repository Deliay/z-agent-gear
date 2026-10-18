import mongoose from 'mongoose';

export const WORKLOAD_LOG_PHASES = ['init', 'post'] as const;
export type WorkloadLogPhase = (typeof WORKLOAD_LOG_PHASES)[number];

export const WORKLOAD_LOG_STATUSES = [
  'pending',
  'running',
  'success',
  'failed',
  'timeout',
] as const;
export type WorkloadLogStatus = (typeof WORKLOAD_LOG_STATUSES)[number];

/** 终态集合：进入这些状态后记录不再推进（`workload:result` 幂等忽略）。 */
export const WORKLOAD_LOG_TERMINAL_STATUSES: readonly WorkloadLogStatus[] = [
  'success',
  'failed',
  'timeout',
];

export function isTerminalWorkloadLogStatus(status: WorkloadLogStatus): boolean {
  return WORKLOAD_LOG_TERMINAL_STATUSES.includes(status);
}

/**
 * 工作负载执行日志（集合 `cloudworkloadlogs`）：cloud-controller 写入、admin-api 只读。
 *
 * `script` 为下发时读取的脚本快照（留档）；`log` 为合并捕获的输出（尾部截断）。
 * 时间戳以服务端为准（契约附录 A.6）。
 */
const cloudWorkloadLogSchema = new mongoose.Schema(
  {
    containerId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    workloadId: { type: mongoose.Schema.Types.ObjectId, required: true },
    workloadName: { type: String, required: true },
    phase: { type: String, enum: WORKLOAD_LOG_PHASES, required: true },
    status: { type: String, enum: WORKLOAD_LOG_STATUSES, required: true },
    script: { type: String, default: '' },
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    // 本次启动该项是否为「必须」；缺省 false（历史记录按非必须展示）
    required: { type: Boolean, default: false },
    exitCode: { type: Number, default: null },
    log: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'cloudworkloadlogs' },
);

export const CloudWorkloadLog = mongoose.model('CloudWorkloadLog', cloudWorkloadLogSchema);

export type ICloudWorkloadLog = mongoose.InferSchemaType<typeof cloudWorkloadLogSchema>;
