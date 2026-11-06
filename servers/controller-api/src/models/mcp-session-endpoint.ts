import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

/**
 * 只读镜像：`customMcpServers` 由 agent-api 签发时写入（MCP+Valut 功能迭代 Phase 3，
 * 提案 D10 快照 `{id,name}`），本服务不读不写；**不得**借镜像改动 `expiresAt` / TTL 索引
 * 语义（两侧模型差异现状保留，计划 F4）。
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
    customMcpServers: { type: [customMcpSnapshotSchema], default: [] },
    tokenHash: { type: String, required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

mcpSessionEndpointSchema.index({ status: 1, expiresAt: 1 }, { expireAfterSeconds: 0 });

applyTenantScope(mcpSessionEndpointSchema);

export const McpSessionEndpoint = mongoose.model('McpSessionEndpoint', mcpSessionEndpointSchema);
export type IMcpSessionEndpoint = mongoose.InferSchemaType<typeof mcpSessionEndpointSchema>;
