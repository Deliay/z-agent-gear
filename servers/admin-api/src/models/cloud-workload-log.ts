import mongoose from 'mongoose';

/**
 * 工作负载执行记录（集合名 `cloudworkloadlogs`）：单一事实源在 cloud-controller（下发时写入）。
 * admin-api **仅只读**——本模型只用于 `find`（控制面不可达时日志查询降级直读），
 * 不创建、不更新、不删除，避免双写不一致（与 `models/cloud-container.ts` 同口径）。
 * 字段与 cloud-controller 写入结构对齐（见 contracts/cloud-controller-websocket.md A.6）。
 */
const cloudWorkloadLogSchema = new mongoose.Schema(
  {
    containerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    workloadId: { type: mongoose.Schema.Types.ObjectId, required: true },
    workloadName: { type: String, required: true },
    phase: { type: String, enum: ['init', 'post'], required: true },
    status: {
      type: String,
      enum: ['pending', 'running', 'success', 'failed', 'timeout'],
      required: true,
    },
    script: { type: String, required: true },
    // 本次执行实际使用的参数值快照（已归一，含默认值）；历史记录缺省为 {}
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    exitCode: { type: Number, default: null },
    log: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { collection: 'cloudworkloadlogs', timestamps: true },
);

export const CloudWorkloadLog = mongoose.model('CloudWorkloadLog', cloudWorkloadLogSchema);

/**
 * 读取某容器的执行记录（只读降级路径，按 `createdAt` 升序 = 执行顺序）。
 * 返回原始 lean 文档，由调用方经 `mapWorkloadLog` 归一为契约形态，避免此处重复映射逻辑。
 */
export async function findStoredWorkloadLogs(
  containerId: string,
): Promise<Array<Record<string, unknown>>> {
  const docs = await CloudWorkloadLog.find({ containerId }).sort({ createdAt: 1 }).lean();
  return docs as unknown as Array<Record<string, unknown>>;
}
