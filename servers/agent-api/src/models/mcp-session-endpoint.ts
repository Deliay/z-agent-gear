import mongoose from 'mongoose';

const mcpSessionEndpointSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    mcpServerIds: [{ type: String }],
    tokenHash: { type: String, required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// NOTE: no TTL index here. Expired documents are kept so that resuming a
// long-paused session can re-issue an endpoint from the stored mcpServerIds;
// expiry is enforced in code (getStatus) and by the JWT's own exp.
mcpSessionEndpointSchema.index({ status: 1 });

export const McpSessionEndpoint = mongoose.model('McpSessionEndpoint', mcpSessionEndpointSchema);
export type IMcpSessionEndpoint = mongoose.InferSchemaType<typeof mcpSessionEndpointSchema>;
