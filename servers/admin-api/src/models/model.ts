import mongoose from 'mongoose';

// 与 servers/agent-api/src/models/model.ts 同步演进
//
// 注意：`scope = 'global'` 内 `name` 全局唯一（跨供应商）由迁移
// `005-model-name-unique-global` 以固定名 `scope_global_name_unique` 创建
// （partialFilterExpression: { scope: 'global' }），**不在此 schema 声明**：
// Mongoose 默认 autoIndex 会在启动连接后立即建索引，与「先清理存量重名再建索引」
// 的迁移顺序竞态，存量重复数据下必然 E11000。迁移是唯一创建入口。
const modelPricingSchema = new mongoose.Schema(
  {
    // 费用中心模型定价（便捷编辑视图）；价目真相在 productprices。
    // 金额一律整数「分」/百万 token（0.01 credits = 1 分）。
    inputPerMillion: { type: Number, default: 0 },
    cachedInputPerMillion: { type: Number, default: 0 },
    outputPerMillion: { type: Number, default: 0 },
    isBillable: { type: Boolean, default: true },
  },
  { _id: false },
);

const modelSchema = new mongoose.Schema({
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true, index: true },
  name: { type: String, required: true },
  isCustom: { type: Boolean, default: false },
  isEnabled: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
  scope: { type: String, enum: ['user', 'global'], default: 'user', index: true },
  // 最长上下文大小（token，正整数）；null = 未设置。与 agent-api 同步演进。
  contextLength: { type: Number, default: null },
  pricing: { type: modelPricingSchema, default: null },
  // 多租户二期：scope=user 行归属租户工作区；scope=global 平台内置行恒 null。
  // 与 agent-api 同步演进（只读镜像）；索引声明必须与迁移 015 切换后形态一致（F10）。
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
}, { timestamps: true });

modelSchema.index({ providerId: 1, name: 1 }, { unique: true });
// 工作区维度复合索引（与 agent-api 迁移 015 的固定名同名同 spec，autoIndex 幂等）
modelSchema.index({ tenantId: 1, workspaceId: 1 }, { name: 'tenantId_1_workspaceId_1' });

export const Model = mongoose.model('Model', modelSchema);
export type IModel = mongoose.InferSchemaType<typeof modelSchema>;
