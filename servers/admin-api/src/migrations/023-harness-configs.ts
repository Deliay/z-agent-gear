import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';
import { HARNESS_CONFIG_TYPES } from '../models/harness-config.js';
import { DEFAULT_COMPACT_COMMAND } from '../services/harness-config.js';

const log = logger.child({ component: 'migration/023-harness-configs' });

export const name = '023-harness-configs';

type Collection = ReturnType<typeof mongoose.connection.collection>;

/**
 * 023-harness-configs：Harness 平台配置（`harnessconfigs`）索引与默认值种子（幂等）。
 *
 * - `{harnessType:1}` 唯一索引 `uniq_harness_config_type` → 每种 Harness 恰一条；
 *   agent-api 只读镜像的同名索引声明必须与此逐字一致（索引由本迁移创建）。
 * - 对三种 Harness 以 `$setOnInsert` upsert 默认压缩指令 `/compact`：已存在行不覆盖
 *   用户配置（`$setOnInsert` 仅在插入路径生效），重复执行无副作用。
 * - 走原生 collection 而非模型，避免 Mongoose `timestamps` 在 upsert 命中已有行时
 *   改写 `updatedAt`（重跑迁移应字节稳定）；插入路径显式补 `createdAt/updatedAt`，
 *   与模型写入的行形态一致（`services/harness-config.ts` 的视图依赖 `updatedAt`）。
 */
export async function createHarnessConfigIndexes(): Promise<void> {
  const configs = mongoose.connection.collection('harnessconfigs') as Collection;
  await configs.createIndex(
    { harnessType: 1 },
    { unique: true, name: 'uniq_harness_config_type' },
  );
}

export async function seedDefaultHarnessConfigs(): Promise<void> {
  const configs = mongoose.connection.collection('harnessconfigs') as Collection;
  const now = new Date();
  for (const harnessType of HARNESS_CONFIG_TYPES) {
    await configs.updateOne(
      { harnessType },
      { $setOnInsert: { compactCommand: DEFAULT_COMPACT_COMMAND, createdAt: now, updatedAt: now } },
      { upsert: true },
    );
  }
}

export async function run(): Promise<void> {
  await createHarnessConfigIndexes();
  await seedDefaultHarnessConfigs();

  const indexes = await mongoose.connection
    .collection('harnessconfigs')
    .indexes()
    .catch(() => []);
  const documentCount = await mongoose.connection
    .collection('harnessconfigs')
    .countDocuments()
    .catch(() => null);
  log.info(
    {
      harnessTypes: [...HARNESS_CONFIG_TYPES],
      indexes: indexes.map((index) => index.name),
      documentCount,
    },
    'migration completed',
  );
}
