import mongoose from 'mongoose';

const mcpServerSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    transport: { type: String, enum: ['registered_proxy'], default: 'registered_proxy' },
    command: { type: String, required: true },
    proxyConnectionId: { type: String, index: true },
    status: { type: String, enum: ['active', 'offline', 'disabled'], default: 'active' },
    lastHeartbeatAt: { type: Date },
  },
  { timestamps: true },
);

mcpServerSchema.index({ userId: 1, name: 1 }, { unique: true });

export const McpServer = mongoose.model('McpServer', mcpServerSchema);
export type IMcpServer = mongoose.InferSchemaType<typeof mcpServerSchema>;
