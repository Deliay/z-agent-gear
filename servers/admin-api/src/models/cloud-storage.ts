import mongoose from 'mongoose';

/**
 * 云存储只读镜像（裁决 17，集合名与 agent-api 的 `cloudstorages` 严格对齐）。
 *
 * 写方单一：`cloudstorages` 只由 agent-api 写入；admin-api 仅由整点结算 tick 读取本镜像，
 * **不挂 scope 插件、不建索引、不写入**（索引由 agent-api 迁移 020 拥有）。
 */
const cloudStorageMirrorSchema = new mongoose.Schema(
  {
    name: { type: String, default: null },
    sizeGi: { type: Number, default: null },
    status: {
      type: String,
      enum: [
        'CREATING',
        'IDLE',
        'ATTACHING',
        'ATTACHED',
        'ARCHIVING',
        'ARCHIVED',
        'DESTROYING',
        'DESTROYED',
        'CREATE_FAILED',
      ],
      default: null,
    },
    billingRate: { type: String, enum: ['FULL', 'HALF'], default: null },
    billingStartedAt: { type: Date, default: null },
    destroyedAt: { type: Date, default: null },
    // agent-api 侧为字符串（BillingAccount._id 的字符串形式）
    billingAccountId: { type: String, default: null },
    tenantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    resourceWorkspaceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    currentArchive: { type: mongoose.Schema.Types.Mixed, default: null },
    usageBytes: { type: Number, default: null },
  },
  { collection: 'cloudstorages', timestamps: false },
);

export const CloudStorageMirror = mongoose.model(
  'CloudStorageMirror',
  cloudStorageMirrorSchema,
);
export type ICloudStorageMirror = mongoose.InferSchemaType<typeof cloudStorageMirrorSchema>;
