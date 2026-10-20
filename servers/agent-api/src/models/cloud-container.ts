import mongoose from 'mongoose';

/**
 * `cloudcontainers` 只读模型（写方为 cloud-controller）。
 * agent-api 仅用于按 hostId 查询容器状态/关联 ID，不写。
 */
const cloudContainerSchema = new mongoose.Schema(
  {
    hostId: { type: String, default: null, index: true },
    controllerKeyId: { type: String, default: null },
    containerApiKeyId: { type: String, default: null },
    userId: { type: String, default: null },
    purpose: { type: String, default: 'idle' },
    status: { type: String, default: 'creating' },
    harnessTypes: { type: [String], default: [] },
    expiresAt: { type: Date, default: null },
    hostName: { type: String, default: null },
    exitReason: { type: String, default: null },
    connectedAt: { type: Date, default: null },
    exitedAt: { type: Date, default: null },
    billingAccountId: { type: String, default: null },
  },
  { collection: 'cloudcontainers', strict: false },
);

export const CloudContainer = mongoose.model('CloudContainer', cloudContainerSchema);
