// 本 schema 与 servers/admin-api/src/models/model.ts 同步演进
//
// 注意：`scope = 'global'` 内 `name` 全局唯一（跨供应商）由 admin-api 迁移
// `005-model-name-unique-global` 以固定名 `scope_global_name_unique` 创建
// （partialFilterExpression: { scope: 'global' }），本服务不声明该索引——
// 用户侧（scope=user）不受影响，仍允许跨 scope 同名。
import mongoose from 'mongoose';
import { applyWorkspaceScope } from '../services/workspace-scope.js';

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
  // 最长上下文大小（token，正整数）；null = 未设置。与 admin-api 同步演进（只读镜像）。
  contextLength: { type: Number, default: null },
  pricing: { type: modelPricingSchema, default: null },
  // 多租户二期：scope=user 行归属租户工作区；scope=global 平台内置行恒 null
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
}, { timestamps: true });

modelSchema.index({ providerId: 1, name: 1 }, { unique: true });
modelSchema.index({ tenantId: 1, workspaceId: 1 });

// 共享型资源：读 = 当前工作区 ∪ 本租户全局（并放行 scope=global 平台内置行）；写仅当前工作区
applyWorkspaceScope(modelSchema, { shared: true, globalScopeVisible: true });

export const Model = mongoose.model('Model', modelSchema);
export type IModel = mongoose.InferSchemaType<typeof modelSchema>;
