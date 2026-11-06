import mongoose from 'mongoose';

/**
 * Valut namespace 注册表（集合 `valutnamespaces`，agent-api 写方）。
 *
 * - `name`：`manual` | `service-{feature}`，**全局跨租户唯一**（`uniq_valut_namespace_name`，
 *   无 tenantId/workspaceId 维度）；
 * - `manual` 由迁移 `023-valut-foundations` 播种（展示名「自定义密钥」）；
 *   `service-{功能点}` 由 `valut-service.ensureNamespace` 启动自检幂等创建；
 * - 作用域插件（计划 D3）：**不挂任何 scope 插件**（全局注册表，跨租户唯一），
 *   不提供用户侧 namespace 管理入口；
 * - `managed`：`name.startsWith('service-')` 的冗余落库，便于查询（提案 §4.1）。
 */
const valutNamespaceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    displayName: { type: String, required: true },
    managed: { type: Boolean, required: true, default: false },
  },
  { collection: 'valutnamespaces', timestamps: true },
);

// 全局唯一（跨租户/跨工作区；迁移 023 同名同键创建）
valutNamespaceSchema.index(
  { name: 1 },
  { unique: true, name: 'uniq_valut_namespace_name' },
);

export const ValutNamespace = mongoose.model('ValutNamespace', valutNamespaceSchema);
export type IValutNamespace = mongoose.InferSchemaType<typeof valutNamespaceSchema>;
