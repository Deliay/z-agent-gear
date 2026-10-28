import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

const mcpServerSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    tenantId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    transport: { type: String, enum: ['registered_proxy', 'http', 'platform'], default: 'registered_proxy' },
    source: { type: String, enum: ['proxy', 'manual', 'platform'], default: 'proxy' },
    enabled: { type: Boolean, default: true },
    command: { type: String },
    url: { type: String },
    headersEncrypted: { type: Object },
    proxyConnectionId: { type: String, index: true },
    status: { type: String, enum: ['active', 'offline', 'disabled'], default: 'active' },
    tools: [{ name: { type: String }, description: { type: String } }],
    toolsSyncedAt: { type: Date },
    lastHeartbeatAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

mcpServerSchema.index({ userId: 1, name: 1 }, { unique: true });

applyTenantScope(mcpServerSchema);

export const McpServer = mongoose.model('McpServer', mcpServerSchema);
export type IMcpServer = mongoose.InferSchemaType<typeof mcpServerSchema>;
