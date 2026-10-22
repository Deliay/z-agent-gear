import mongoose from 'mongoose';

export const name = '006-todo-elicitation-request-id-index';

/**
 * 问询终态写入/去重按 `elicitationData.requestId` 定位。
 *
 * Mongoose `autoIndex` 在关闭索引自动创建的部署（或存量集合）下会静默缺失，
 * 导致终态写入走全集合扫描；由迁移显式创建（幂等）。
 */
export async function run(): Promise<void> {
  const collection = mongoose.connection.collection('todoitems');
  await collection.createIndex(
    { 'elicitationData.requestId': 1 },
    { name: 'elicitation_request_id' },
  );
  console.log('[Migration 006] Ensured index elicitation_request_id on todoitems');
}
