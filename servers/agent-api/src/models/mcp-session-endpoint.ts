import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

const mcpSessionEndpointSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    tenantId: { type: String, required: true, index: true },
    mcpServerIds: [{ type: String }],
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
