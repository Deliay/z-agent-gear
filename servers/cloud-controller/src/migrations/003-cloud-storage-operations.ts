import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'migration/003-cloud-storage-operations' });

export const name = '003-cloud-storage-operations';

/**
 * 003-cloud-storage-operations：存储级操作台账索引（契约 A.2.11 ~ A.2.13 / D11）。
 *
 * 只建索引、不改数据，幂等可重跑：
 * - `uniq_storage_op_inflight`：`{storageId:1}` 部分唯一，仅约束 `pending/running`，
 *   插入撞键即 409 `OPERATION_RUNNING`（天然抗并发，无需读后写）；
 * - `storage_op_status`：`{status:1, updatedAt:1}`，巡检扫描进行中/超时操作；
 * - `storage_op_history`：`{storageId:1, createdAt:-1}`，运维按存储查看历史。
 *
 * 显式创建（不依赖模型 `autoIndex`），索引定义与 `models/cloud-storage-operation.ts` 保持一致。
 */
export async function run(): Promise<void> {
  const collection = mongoose.connection.collection('cloudstorageoperations');

  await collection.createIndex(
    { storageId: 1 },
    {
      unique: true,
      name: 'uniq_storage_op_inflight',
      partialFilterExpression: { status: { $in: ['pending', 'running'] } },
    },
  );
  await collection.createIndex(
    { status: 1, updatedAt: 1 },
    { name: 'storage_op_status' },
  );
  await collection.createIndex(
    { storageId: 1, createdAt: -1 },
    { name: 'storage_op_history' },
  );

  log.info(
    {
      event: 'index-ensured',
      indexes: ['uniq_storage_op_inflight', 'storage_op_status', 'storage_op_history'],
    },
    'ensured indexes on cloudstorageoperations',
  );
}
