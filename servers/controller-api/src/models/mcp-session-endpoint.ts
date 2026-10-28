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
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

mcpSessionEndpointSchema.index({ status: 1, expiresAt: 1 }, { expireAfterSeconds: 0 });

applyTenantScope(mcpSessionEndpointSchema);

export const McpSessionEndpoint = mongoose.model('McpSessionEndpoint', mcpSessionEndpointSchema);
export type IMcpSessionEndpoint = mongoose.InferSchemaType<typeof mcpSessionEndpointSchema>;
