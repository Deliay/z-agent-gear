import mongoose from 'mongoose';

const mcpProxyKeySchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true },
    keyHash: { type: String, required: true },
    keyPrefix: { type: String, required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    lastUsedAt: { type: Date },
  },
  { timestamps: true },
);

mcpProxyKeySchema.index({ userId: 1, name: 1 }, { unique: true });

export const McpProxyKey = mongoose.model('McpProxyKey', mcpProxyKeySchema);
export type IMcpProxyKey = mongoose.InferSchemaType<typeof mcpProxyKeySchema>;
