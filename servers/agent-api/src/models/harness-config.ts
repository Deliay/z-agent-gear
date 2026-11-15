// 与 servers/admin-api/src/models/harness-config.ts 同步演进（本文件为只读镜像）
import mongoose from 'mongoose';
import { HARNESS_TYPES } from './cloud-host.js';

/**
 * Harness 平台配置只读镜像（集合 `harnessconfigs`，唯一写方为 admin-api）。
 *
 * - 索引 `uniq_harness_config_type` 由 admin-api 迁移 023 创建（本服务不重复建，
 *   `autoIndex=false` 纪律同 authproviders 镜像）；
 * - agent-api 仅在工作流返工/复工恢复原始会话时读取压缩指令。
 */
const harnessConfigSchema = new mongoose.Schema(
  {
    harnessType: { type: String, required: true, enum: HARNESS_TYPES },
    // 原始上下文压缩指令（trim 后 1~64、以 / 开头；默认 /compact）
    compactCommand: { type: String, required: true, trim: true },
  },
  { collection: 'harnessconfigs', timestamps: true, autoIndex: false },
);

harnessConfigSchema.index({ harnessType: 1 }, { unique: true, name: 'uniq_harness_config_type' });

export const HarnessConfig = mongoose.model('HarnessConfig', harnessConfigSchema);
export type IHarnessConfig = mongoose.InferSchemaType<typeof harnessConfigSchema>;
