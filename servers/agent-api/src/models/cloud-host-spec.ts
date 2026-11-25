import mongoose from 'mongoose';

/**
 * 容器规格只读镜像（集合 `cloudhostspecs`）：写方为 admin-api。
 *
 * 只读纪律：`autoIndex: false` 且不声明索引（与 `harness-config.ts` / `auth-provider.ts` 同款）。
 * 可见性判定由 `services/cloud-host-spec-service.ts` 在查询侧显式过滤，不挂工作区/租户作用域插件。
 */
const cloudHostSpecSchema = new mongoose.Schema(
  {
    name: { type: String },
    cpu: { type: Number },
    memoryGi: { type: Number },
    ephemeralStorageGi: { type: Number },
    whitelistEnabled: { type: Boolean, default: false },
    allowedTenantIds: { type: [String], default: [] },
    isPreset: { type: Boolean, default: false },
    presetKey: { type: String, default: null },
  },
  { collection: 'cloudhostspecs', timestamps: true, autoIndex: false, strict: false },
);

export const CloudHostSpec = mongoose.model('CloudHostSpec', cloudHostSpecSchema);
