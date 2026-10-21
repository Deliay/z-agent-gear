import mongoose from 'mongoose';

/**
 * `cloudworkloads` 只读模型（写方为 admin-api）。
 * agent-api 仅按 presetKey/harnessType 读取 harness 预制项构造 workloadPlan。
 */
const cloudWorkloadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    presetKey: { type: String, default: null },
    workloadKind: { type: String, default: 'standard' },
    harnessType: { type: String, default: null },
    initScript: { type: String, default: null },
    postScript: { type: String, default: null },
    paramSchema: { type: [mongoose.Schema.Types.Mixed], default: [] },
    dependsOnWorkloadIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    isPreset: { type: Boolean, default: false },
  },
  { collection: 'cloudworkloads', strict: false },
);

export const CloudWorkload = mongoose.model('CloudWorkload', cloudWorkloadSchema);
