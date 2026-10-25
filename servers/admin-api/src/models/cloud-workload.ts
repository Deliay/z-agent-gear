import mongoose from 'mongoose';

/**
 * 参数定义子文档（提案 §4.1）：`key`/`label`/`type`/`options`/`defaultValue`。
 * 服务层强制校验（key 正则、label 1~64、options 仅下拉类型、defaultValue 按类型合法）。
 */
const workloadParamSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    type: {
      type: String,
      enum: ['select', 'multi_select', 'text', 'boolean'],
      required: true,
    },
    options: { type: [String], default: [] },
    defaultValue: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { _id: false },
);

/**
 * 工作负载定义（集合名与提案 §4.1 严格对齐：`cloudworkloads`）。
 * admin-api 为写入方（CRUD）；cloud-controller 只读该集合以读取脚本。
 * 校验规则（名称 trim 后 1~64/唯一、脚本 ≤16 KiB、至少其一非空、参数/依赖见 §计划期裁决 6）
 * 由服务层强制。
 */
const cloudWorkloadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    initScript: { type: String, default: null },
    postScript: { type: String, default: null },
    // 参数定义；空数组表示无配置（裁决 6）
    paramSchema: { type: [workloadParamSchema], default: [] },
    // 依赖的工作负载，按配置顺序初始化；最多 5 个，禁止自依赖/环（裁决 6）
    dependsOnWorkloadIds: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
      index: true,
    },
    // 预制项稳定标识：docker/nodejs/dotnet/aspire；非预制项为 null
    // 注意：MongoDB 的 sparse 唯一索引会索引值为 null 的文档，若直接 `unique+sparse+default null`
    // 则第二个非预制项会因 presetKey=null 触发唯一冲突。改用「部分唯一索引」（仅对字符串生效），
    // 语义等价且不误伤非预制项。
    presetKey: { type: String, default: null },
    // 展示用：是否为预制工作负载
    isPreset: { type: Boolean, default: false },
    // 工作负载类别：standard（通用初始化）/ harness（云电脑 harness 运行环境）
    workloadKind: {
      type: String,
      enum: ['standard', 'harness'],
      default: 'standard',
      index: true,
    },
    // harness 类型（本期 opencode / kimi_code）；standard 为 null
    harnessType: { type: String, enum: ['opencode', 'kimi_code', null], default: null },
  },
  { collection: 'cloudworkloads', timestamps: true },
);

cloudWorkloadSchema.index(
  { presetKey: 1 },
  { unique: true, partialFilterExpression: { presetKey: { $type: 'string' } } },
);

export const CloudWorkload = mongoose.model('CloudWorkload', cloudWorkloadSchema);
export type ICloudWorkload = mongoose.InferSchemaType<typeof cloudWorkloadSchema>;
