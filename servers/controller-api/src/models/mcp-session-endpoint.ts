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

mcpSessionEndpointSchema.index({ status: 1, expiresAt: 1 }, { expireAfterSeconds: 0 });

export const McpSessionEndpoint = mongoose.model('McpSessionEndpoint', mcpSessionEndpointSchema);
export type IMcpSessionEndpoint = mongoose.InferSchemaType<typeof mcpSessionEndpointSchema>;
