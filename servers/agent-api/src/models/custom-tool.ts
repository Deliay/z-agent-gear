import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';
import { applyWorkspaceScope } from '../services/workspace-scope.js';

/**
 * 自定义工具（集合 `customtools`，agent-api 唯一写方；需求 #449）。
 *
 * - 工作区级资源：`tenantId` + `workspaceId` 挂 `applyWorkspaceScope`（**独占型**）；
 *   `applyTenantScope` 对无 `userId` 集合为 no-op，`tenantId` 由服务层显式写入
 *   （与 `custommcpservers` / `valutentries` 同口径）。
 * - `name`：trim 后 1..64，**工作区内唯一**——唯一索引 `uniq_custom_tool_workspace_name`
 *   `{workspaceId,name}`，**与迁移 026 同名同键**（服务层重名 → `duplicate custom tool name`）。
 * - `type`：`prompt` | `http`；`prompt` 与 `http` 二选一（服务层校验，互斥字段）。
 * - `args`：`[{key,name,description?}]`，key 匹配 `^[A-Za-z_][A-Za-z0-9_]{0,63}$` 且工具内唯一、≤32。
 * - Fragment 子文档形状对齐 `contracts/fragment-template.md`（`type/value/format`，`_id:false`）。
 * - `http.bodyType`：`text` | `json` | `form`；`form[].type=file` 本期保留字段但拒绝保存。
 * - 明文边界：本集合不存任何 Valut 明文，只存引用名（按名弱引用）。
 */

const fragmentSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Plain', 'Valut', 'Parameter'], required: true },
    value: { type: String, required: true },
    format: { type: String, enum: ['Generic', 'Json', 'Uri'], required: true },
  },
  { _id: false },
);

const argSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
  },
  { _id: false },
);

const keyValueSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    value: { type: [fragmentSchema], default: [] },
  },
  { _id: false },
);

const formFieldSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    type: { type: String, enum: ['text', 'file'], required: true, default: 'text' },
    value: { type: [fragmentSchema], default: [] },
  },
  { _id: false },
);

const httpConfigSchema = new mongoose.Schema(
  {
    method: { type: String, required: true },
    endpoint: { type: [fragmentSchema], default: [] },
    insecure: { type: Boolean, default: false },
    bodyType: { type: String, enum: ['text', 'json', 'form'], default: null },
    body: { type: [fragmentSchema], default: [] },
    form: { type: [formFieldSchema], default: [] },
    headers: { type: [keyValueSchema], default: [] },
    queries: { type: [keyValueSchema], default: [] },
  },
  { _id: false },
);

const customToolSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: null, maxlength: 512 },
    type: { type: String, enum: ['prompt', 'http'], required: true },
    args: { type: [argSchema], default: [] },
    prompt: { type: [fragmentSchema], default: null },
    http: { type: httpConfigSchema, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'customtools', timestamps: true },
);

// 工作区内名称唯一（迁移 026 同名创建；服务层预检 + E11000 兜底）
customToolSchema.index(
  { workspaceId: 1, name: 1 },
  { unique: true, name: 'uniq_custom_tool_workspace_name' },
);
customToolSchema.index({ tenantId: 1 }, { name: 'custom_tool_tenant' });

applyTenantScope(customToolSchema);
applyWorkspaceScope(customToolSchema); // 独占型（不设 shared）

export const CustomTool = mongoose.model('CustomTool', customToolSchema);
export type ICustomTool = mongoose.InferSchemaType<typeof customToolSchema>;
