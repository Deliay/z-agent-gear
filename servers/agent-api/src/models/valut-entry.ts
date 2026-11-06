import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';
import { applyWorkspaceScope } from '../services/workspace-scope.js';

const valueEncryptedSchema = new mongoose.Schema(
  {
    iv: { type: String, required: true },
    ciphertext: { type: String, required: true },
    tag: { type: String, required: true },
  },
  { _id: false },
);

/**
 * Valut 条目（集合 `valutentries`，agent-api 写方）：工作区级加密 key-value secrets。
 *
 * - 值加密入库（AES-256-GCM，复用 `services/crypto.ts`，密钥 `CREDENTIAL_ENCRYPTION_KEY`）；
 *   **明文不出服务端**——契约无 value 出参，解密仅 `valut-service.resolveValue`（服务端内部）。
 * - `key`：trim 后 1..128、禁空白与控制字符（服务层校验）；唯一索引
 *   `{workspaceId, namespace, key}`（`uniq_valut_entry_workspace_namespace_key`，
 *   与迁移 023 同名同键）。
 * - 作用域：`workspaceId` 挂 `applyWorkspaceScope`（**独占型**：读=当前工作区、
 *   写=当前工作区且非 readOnly，全局工作区 developer 写统一拦截
 *   `global workspace is read-only`）；`tenantId` 挂 `applyTenantScope`
 *   （该插件仅对含 `userId` 的集合注入，本集合无 `userId`（`createdBy` 承载创建人），
 *   故 tenantId 由 `valut-service` 显式写入——与提案 §4.1 字段表一致）。
 * - `editable`/`deletable` 默认 true（`service-mcp-bearer-tokens` 托管条目
 *   editable=true / deletable=false）。
 */
const valutEntrySchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
    // 引用 valutnamespaces.name（manual | service-*）
    namespace: { type: String, required: true },
    key: { type: String, required: true, trim: true },
    valueEncrypted: { type: valueEncryptedSchema, required: true },
    editable: { type: Boolean, required: true, default: true },
    deletable: { type: Boolean, required: true, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'valutentries', timestamps: true },
);

// 工作区 + namespace + key 唯一（迁移 023 同名创建）
valutEntrySchema.index(
  { workspaceId: 1, namespace: 1, key: 1 },
  { unique: true, name: 'uniq_valut_entry_workspace_namespace_key' },
);
valutEntrySchema.index({ namespace: 1 }, { name: 'valut_entry_namespace' });
valutEntrySchema.index({ tenantId: 1 }, { name: 'valut_entry_tenant' });

applyTenantScope(valutEntrySchema);
applyWorkspaceScope(valutEntrySchema); // 独占型（不设 shared）

export const ValutEntry = mongoose.model('ValutEntry', valutEntrySchema);
export type IValutEntry = mongoose.InferSchemaType<typeof valutEntrySchema>;
