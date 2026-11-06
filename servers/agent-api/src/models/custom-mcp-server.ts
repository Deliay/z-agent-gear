import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';
import { applyWorkspaceScope } from '../services/workspace-scope.js';

/**
 * 自定义 MCP（集合 `custommcpservers`，agent-api 写方；MCP+Valut 功能迭代 Phase 2）。
 *
 * - 工作区级资源：`tenantId` + `workspaceId` 挂 `applyWorkspaceScope`（**独占型**，计划 D3）；
 *   `applyTenantScope` 对无 `userId` 集合为 no-op，`tenantId` 由服务层显式写入（与 valutentries 同口径）。
 * - `name`：trim 后 1..64，工作区内唯一——唯一索引 `uniq_custom_mcp_workspace_name`
 *   `{workspaceId,name}`，**与迁移 023 已建索引同名同键**。
 * - `endpoint`：仅 `http://`/`https://` 且 ≤1024（服务层校验，`invalid mcp endpoint`）。
 * - `customHeaders`：`Map<String,[String]>` 同名多值；服务层校验 key 禁空白/冒号（并规避
 *   Mongoose Map/BSON 键限制：禁点号、`$` 前缀与保留键名）、value ≤4096、header 总数 ≤32。
 * - `authType`：`none` | `bearer`；`bearerValutEntryId` bearer 时指向 Valut 条目
 *   （自建 `service-mcp-bearer-tokens` 或引用 `manual`），none 时为 null。
 * - 明文边界：本集合不存 bearer token（token 加密存于 `valutentries.valueEncrypted`），
 *   出参装配由 `custom-mcp-service` 显式白名单字段完成。
 */
const customMcpServerSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: null, maxlength: 512 },
    endpoint: { type: String, required: true },
    authType: { type: String, enum: ['none', 'bearer'], required: true, default: 'none' },
    // 同名 header 多值；服务层归一为 Map 落库
    customHeaders: { type: Map, of: [String], default: {} },
    bearerValutEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ValutEntry',
      default: null,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { collection: 'custommcpservers', timestamps: true },
);

// 工作区内名称唯一（迁移 023 同名创建；服务层重名 → invalid mcp name）
customMcpServerSchema.index(
  { workspaceId: 1, name: 1 },
  { unique: true, name: 'uniq_custom_mcp_workspace_name' },
);
customMcpServerSchema.index({ tenantId: 1 }, { name: 'custom_mcp_tenant' });

applyTenantScope(customMcpServerSchema);
applyWorkspaceScope(customMcpServerSchema); // 独占型（不设 shared）

export const CustomMcpServer = mongoose.model('CustomMcpServer', customMcpServerSchema);
export type ICustomMcpServer = mongoose.InferSchemaType<typeof customMcpServerSchema>;
