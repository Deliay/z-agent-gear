import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'migration/004-harness-secrets' });

export const name = '004-harness-secrets';

/**
 * 004-harness-secrets：云电脑运行期 secret 持久化集合索引（Issue #446）。
 *
 * 只建索引、不改数据，幂等可重跑：`uniq_harness_secret_container` 保证一个容器至多一条
 * secret 记录（写路径 upsert，撞键即覆盖）。显式创建（不依赖模型 `autoIndex`），
 * 索引定义与 `models/harness-secret.ts` 保持一致。
 */
export async function run(): Promise<void> {
  const collection = mongoose.connection.collection('cloudcontainersecrets');
  await collection.createIndex(
    { containerId: 1 },
    { unique: true, name: 'uniq_harness_secret_container' },
  );
  log.info(
    { event: 'index-ensured', indexes: ['uniq_harness_secret_container'] },
    'ensured indexes on cloudcontainersecrets',
  );
}
