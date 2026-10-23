import mongoose from 'mongoose';

export const name = '008-workflow-pr-handler-lower-id';

/**
 * PR 联动登记表新增 `pullRequestIdLower`（小写归一列）并建索引（幂等）。
 *
 * 事件入口需要大小写不敏感匹配，原实现用 `$regex + $options: 'i'`，
 * 无法命中 `pullRequestId` 索引，事件高峰会全表扫描。改为写入时归一化小写、
 * 查询时精确匹配。历史行先回填再加索引；失败不落迁移记录，下次启动重试。
 */
export async function run(): Promise<void> {
  const collection = mongoose.connection.collection('workflowprhandlers');
  await collection.updateMany(
    { pullRequestIdLower: { $exists: false } },
    [{ $set: { pullRequestIdLower: { $toLower: '$pullRequestId' } } }],
  );
  await collection.createIndex({ pullRequestIdLower: 1 });
  console.log('[Migration 008] Backfilled pullRequestIdLower and ensured index');
}
