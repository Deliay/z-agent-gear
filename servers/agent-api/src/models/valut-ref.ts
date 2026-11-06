import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

/**
 * Valut 引用关系（集合 `valutrefs`，agent-api 写方）：某条 entry 被哪些功能点数据引用。
 *
 * - 一条 entry 可挂多条 ref（多对一）；`{feature, refId}` 唯一
 *   （`uniq_valut_ref_feature_refid`，同一条数据在同一功能点下至多引用一条 entry，
 *   换绑=先删后建），`{valutEntryId}` 普通索引（`valut_ref_entry`）供按 entry 反查。
 * - `feature` 存功能点名（不带 `service-` 前缀，如 `mcp-bearer-tokens`）；
 *   `refLabel` 为展示用冗余（数据删除时 ref 同步删除，不会悬挂）。
 * - `tenantId/workspaceId` 冗余落库，便于按工作区清扫与一致性核对。
 * - 作用域插件（计划 D3）：**不挂 `applyWorkspaceScope`**（始终经 entry 间接访问，
 *   服务层按 entry 的 workspaceId 校验）；`tenantId` 挂 `applyTenantScope`
 *   （本集合无 `userId`，插件不注入，tenantId 由服务层显式写入）。
 */
const valutRefSchema = new mongoose.Schema(
  {
    valutEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ValutEntry',
      required: true,
    },
    feature: { type: String, required: true },
    refId: { type: String, required: true },
    refLabel: { type: String, default: null },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
  },
  { collection: 'valutrefs', timestamps: true },
);

// 同一数据在同一功能点下至多引用一条 entry（迁移 023 同名创建）
valutRefSchema.index(
  { feature: 1, refId: 1 },
  { unique: true, name: 'uniq_valut_ref_feature_refid' },
);
// 按 entry 批量反查（listGrouped 一次 $in 查询，避免 N+1；迁移 023 同名创建）
valutRefSchema.index({ valutEntryId: 1 }, { name: 'valut_ref_entry' });

applyTenantScope(valutRefSchema);
// 刻意不挂 applyWorkspaceScope（D3）：refs 无独立可见集，读写一律经 entry 归属校验

export const ValutRef = mongoose.model('ValutRef', valutRefSchema);
export type IValutRef = mongoose.InferSchemaType<typeof valutRefSchema>;
