import mongoose from 'mongoose';

export const CONTAINER_STATUSES = [
  'creating',
  'connecting',
  'online',
  'exited',
  'destroying',
  'failed',
] as const;

export type CloudContainerStatus = (typeof CONTAINER_STATUSES)[number];

export const CONTAINER_PURPOSES = ['idle', 'admin-task', 'workflow', 'session'] as const;

export type CloudContainerPurpose = (typeof CONTAINER_PURPOSES)[number];

/**
 * 终态集合：进入这些状态后一次性 token 作废（契约 §3.1）。
 */
export const TERMINAL_STATUSES: readonly CloudContainerStatus[] = [
  'exited',
  'destroying',
  'failed',
];

export function isTerminalStatus(status: CloudContainerStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

const cloudContainerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    namespace: { type: String, required: true },
    status: {
      type: String,
      enum: CONTAINER_STATUSES,
      default: 'creating',
      index: true,
    },
    purpose: { type: String, enum: CONTAINER_PURPOSES, required: true },
    refId: { type: String, default: null },
    userId: { type: String, default: null },
    tokenHash: { type: String, default: null },
    image: { type: String, required: true },
    connectedAt: { type: Date, default: null },
    exitedAt: { type: Date, default: null },
    exitReason: { type: String, default: null },
  },
  { timestamps: true, collection: 'cloudcontainers' },
);

export const CloudContainer = mongoose.model('CloudContainer', cloudContainerSchema);

export type ICloudContainer = mongoose.InferSchemaType<typeof cloudContainerSchema>;
