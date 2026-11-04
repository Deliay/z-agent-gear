import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';
import { ensureIndex } from './index-utils.js';

const log = logger.child({ component: 'migration/022-cloud-storage-fork' });

export const name = '022-cloud-storage-fork';

type Collection = ReturnType<typeof mongoose.connection.collection>;

/**
 * 022-cloud-storage-fork：`cloudstorages` fork 来源索引（云存储归档优化 / 提案 §4.1）。
 *
 * `{ resourceWorkspaceId: 1, forkedFromStorageId: 1 }` 部分索引（仅 objectId 值，
 * 非 fork 行不占索引）；幂等显式创建，不回填存量（历史行缺字段容忍）。
 * 与 `models/cloud-storage.ts` 的 `cloud_storage_fork_source` 保持一致。
 */
export const CLOUD_STORAGE_FORK_INDEX = {
  keys: { resourceWorkspaceId: 1, forkedFromStorageId: 1 },
  options: {
    name: 'cloud_storage_fork_source',
    partialFilterExpression: { forkedFromStorageId: { $type: 'objectId' } },
  },
} as const;

export async function run(): Promise<void> {
  const collection = mongoose.connection.collection('cloudstorages');
  await ensureIndex(
    collection as Collection,
    CLOUD_STORAGE_FORK_INDEX.keys,
    CLOUD_STORAGE_FORK_INDEX.options as never,
  );
  const indexes = await collection.indexes().catch(() => []);
  log.info({ indexes: indexes.map((index) => index.name) }, 'migration completed');
}
