import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';
import { ensureIndex } from './index-utils.js';

const log = logger.child({ component: 'migration/020-cloud-storage-indexes' });

export const name = '020-cloud-storage-indexes';

type Collection = ReturnType<typeof mongoose.connection.collection>;

/**
 * `cloudstorages` 索引声明（与 `models/cloud-storage.ts` 逐条一致）。
 *
 * 生产环境 `autoIndex=false` 时由本迁移显式兜底创建；`ensureIndex` 幂等，
 * 并兼容 Mongoose 默认名抢先建出的同键索引。迁移只建索引、不回填存量。
 */
export const CLOUD_STORAGE_INDEXES = [
  {
    keys: { resourceWorkspaceId: 1, nameKey: 1 },
    options: {
      unique: true,
      name: 'uniq_cloud_storage_workspace_name',
      partialFilterExpression: { destroyedAt: null },
    },
  },
  {
    keys: { attachedCloudHostId: 1 },
    options: {
      unique: true,
      name: 'uniq_cloud_storage_attached_host',
      partialFilterExpression: { attachedCloudHostId: { $type: 'objectId' } },
    },
  },
  {
    keys: { tenantId: 1 },
    options: { name: 'cloud_storage_tenant' },
  },
  {
    keys: { resourceWorkspaceId: 1, status: 1 },
    options: { name: 'cloud_storage_workspace_status' },
  },
  {
    keys: { status: 1, billingStartedAt: 1 },
    options: { name: 'cloud_storage_status_billing' },
  },
] as const;

export async function createCloudStorageIndexes(): Promise<void> {
  const collection = mongoose.connection.collection('cloudstorages');
  for (const entry of CLOUD_STORAGE_INDEXES) {
    await ensureIndex(collection as Collection, entry.keys, entry.options as never);
  }
}

export async function run(): Promise<void> {
  await createCloudStorageIndexes();
  const collection = mongoose.connection.collection('cloudstorages');
  const indexes = await collection.indexes().catch(() => []);
  log.info({ indexes: indexes.map((index) => index.name) }, 'migration completed');
}
