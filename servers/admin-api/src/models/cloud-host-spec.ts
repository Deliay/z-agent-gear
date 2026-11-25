import mongoose from 'mongoose';

/**
 * 容器规格（集合 `cloudhostspecs`）：admin-api 唯一写方，agent-api 只读镜像。
 *
 * 组合规则（服务端强制）：三项全 0 为唯一允许含 0 的组合（不限制容器）；其余组合三项均 ≥1。
 * 可见性：`whitelistEnabled=false` 全员可见；`true` 时仅 `allowedTenantIds` 内租户可见
 *（空名单 = 无租户可见）。规格修改/删除只影响后续创建，已创建云电脑以快照为准。
 */
const cloudHostSpecSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    cpu: { type: Number, required: true },
    memoryGi: { type: Number, required: true },
    ephemeralStorageGi: { type: Number, required: true },
    whitelistEnabled: { type: Boolean, default: false },
    // 白名单租户 id（String 口径，与 cloudcontainers.tenantId 一致）
    allowedTenantIds: { type: [String], default: [] },
    isPreset: { type: Boolean, default: false },
    // 预制播种键；非预制为 null。partial unique（仅字符串生效）避免多个 null 冲突。
    presetKey: { type: String, default: null },
  },
  { collection: 'cloudhostspecs', timestamps: true },
);

cloudHostSpecSchema.index(
  { presetKey: 1 },
  { unique: true, partialFilterExpression: { presetKey: { $type: 'string' } } },
);
cloudHostSpecSchema.index({ whitelistEnabled: 1, allowedTenantIds: 1 });

export const CloudHostSpec = mongoose.model('CloudHostSpec', cloudHostSpecSchema);
export type ICloudHostSpec = mongoose.InferSchemaType<typeof cloudHostSpecSchema>;
