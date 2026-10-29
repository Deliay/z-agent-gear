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
    // 与 cloud-controller 写方同步演进（多租户一期）：tenantId 与 userId 同值。
    tenantId: { type: String, default: null, index: true },
    // 与 cloud-controller 写方同步演进（多租户二期）：租户工作区 id（String 口径，startHarness 下发）
    workspaceId: { type: String, default: null, index: true },
    purpose: { type: String, default: 'idle' },
    status: { type: String, default: 'creating' },
    harnessTypes: { type: [String], default: [] },
    expiresAt: { type: Date, default: null },
    hostName: { type: String, default: null },
    exitReason: { type: String, default: null },
    connectedAt: { type: Date, default: null },
    exitedAt: { type: Date, default: null },
    billingAccountId: { type: String, default: null },
    currentWorkloadName: { type: String, default: null },
    installedWorkloads: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { collection: 'cloudcontainers', strict: false },
);

export const CloudContainer = mongoose.model('CloudContainer', cloudContainerSchema);
