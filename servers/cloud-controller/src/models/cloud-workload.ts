import mongoose from 'mongoose';

export const WORKLOAD_PARAM_TYPES = ['select', 'multi_select', 'text', 'boolean'] as const;
export type WorkloadParamType = (typeof WORKLOAD_PARAM_TYPES)[number];

/**
 * 工作负载参数定义（`cloudworkloads.paramSchema[]`）：cloud-controller 只读，
 * 用于旧版 admin-api 请求（无 `workloadPlan`）时的默认参数归一（提案 §4.1）。
 */
export interface WorkloadParamField {
  key: string;
  label: string;
  type: WorkloadParamType;
  options: string[];
  defaultValue: unknown;
}

const workloadParamFieldSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, enum: WORKLOAD_PARAM_TYPES, required: true },
    options: { type: [String], default: [] },
    defaultValue: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { _id: false },
);

/**
 * 工作负载只读模型（集合 `cloudworkloads`）。
 *
 * 工作负载由 admin-api 写入，cloud-controller 仅只读，用于在容器回连（init）与
 * 销毁（post）时读取脚本并写入执行日志快照（契约 §2.9、提案 §4.1）；
 * `paramSchema`/`dependsOnWorkloadIds` 供旧版请求的兜底展开读取。
 */
const cloudWorkloadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    initScript: { type: String, default: null },
    postScript: { type: String, default: null },
    paramSchema: { type: [workloadParamFieldSchema], default: [] },
    dependsOnWorkloadIds: { type: [mongoose.Schema.Types.ObjectId], default: [], index: true },
    // 工作负载类别：standard（通用初始化）/ harness（云电脑 harness 运行环境）
    workloadKind: {
      type: String,
      enum: ['standard', 'harness'],
      default: 'standard',
      index: true,
    },
    // harness 类型（本期仅 opencode）；standard 为 null
    harnessType: { type: String, enum: ['opencode', null], default: null },
  },
  { timestamps: true, collection: 'cloudworkloads' },
);

export const CloudWorkload = mongoose.model('CloudWorkload', cloudWorkloadSchema);

export type ICloudWorkload = mongoose.InferSchemaType<typeof cloudWorkloadSchema>;
