import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

/**
 * 会话 custom MCP 作用域快照条目（MCP+Valut 功能迭代 Phase 3，提案 D10）：
 * `name` 供 loopback 地址路由（与既有 `serverNames` 口径一致），`id` 供转发器
 * 每次请求实时加载配置——改名不影响存量会话路由，编辑配置即时生效。
 * `_id:false` 子文档：不产生无意义的子文档主键。
 */
const customMcpSnapshotSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
  },
  { _id: false },
);

const mcpSessionEndpointSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },
    mcpServerIds: [{ type: String }],
    // 自定义 MCP（工作区级）作用域快照，与 tokenHash 同一次 upsert 落库（D2）；
    // 存量行缺省视为空数组（reissue/dispatch 侧 `?? []` 兜底）
    customMcpServers: { type: [customMcpSnapshotSchema], default: [] },
    tokenHash: { type: String, required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    // 工作流节点会话 endpoint 标记：有效性跟随工作流实例，而非 TTL/会话关闭
    workflowInstanceId: { type: String, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// NOTE: no TTL index here. Expired documents are kept so that resuming a
// long-paused session can re-issue an endpoint from the stored mcpServerIds;
// expiry is enforced in code (getStatus) and by the JWT's own exp.
mcpSessionEndpointSchema.index({ status: 1 });

applyTenantScope(mcpSessionEndpointSchema);

export const McpSessionEndpoint = mongoose.model('McpSessionEndpoint', mcpSessionEndpointSchema);
export type IMcpSessionEndpoint = mongoose.InferSchemaType<typeof mcpSessionEndpointSchema>;

/** `customMcpServers` 快照条目：name 供路由、id 供转发器实时加载配置（提案 D10）。 */
export interface CustomMcpSnapshotEntry {
  id: string;
  name: string;
}
