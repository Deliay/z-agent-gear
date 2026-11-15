// 与 servers/agent-api/src/models/harness-config.ts 同步演进（admin-api 为唯一写方，agent-api 只读镜像）
import mongoose from 'mongoose';

/** Harness 类型（与 contracts/cloud-host.graphql 的 HarnessType 同枚举值）。 */
export const HARNESS_CONFIG_TYPES = ['OPENCODE', 'KIMI_CODE', 'DEEPSEEK_HARNESS'] as const;
export type HarnessConfigType = (typeof HARNESS_CONFIG_TYPES)[number];

/**
 * Harness 平台配置（集合 `harnessconfigs`）。
 *
 * - **唯一写方 admin-api**（后台「Harness 配置」页）；agent-api 只读镜像（工作流返工/复工
 *   恢复原始会话时解析压缩指令），索引由 admin-api 迁移 `023-harness-configs` 幂等创建。
 * - 三种 Harness 固定存在：未落库行由 `services/harness-config.ts` 以默认 `/compact` 归一返回。
 * - `compactCommand` 以 trim 后 1~64 字符且 `/` 开头为合法（服务层校验，非法抛
 *   `invalid compact command`）。
 */
const harnessConfigSchema = new mongoose.Schema(
  {
    harnessType: { type: String, required: true, enum: HARNESS_CONFIG_TYPES },
    compactCommand: { type: String, required: true, trim: true },
  },
  { collection: 'harnessconfigs', timestamps: true },
);

// 每种 Harness 恰一条；与迁移 023 固定名逐字一致（agent-api 镜像声明必须同步）
harnessConfigSchema.index({ harnessType: 1 }, { unique: true, name: 'uniq_harness_config_type' });

export const HarnessConfig = mongoose.model('HarnessConfig', harnessConfigSchema);
export type IHarnessConfig = mongoose.InferSchemaType<typeof harnessConfigSchema>;
