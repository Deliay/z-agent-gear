import mongoose from 'mongoose';

export const name = '007-workflow-pr-handler-index';

/**
 * PR 联动登记表索引显式创建（幂等）。
 *
 * `workflowprhandlers` 的唯一索引在 `autoIndex` 关闭的部署下会静默缺失，
 * 并发注册将由唯一键兜底；其余查询索引避免事件入口/实例列表全表扫描。
 * 失败不落迁移记录，下次启动重试。
 */
export async function run(): Promise<void> {
  const collection = mongoose.connection.collection('workflowprhandlers');
  await collection.createIndex({ pullRequestId: 1 });
  await collection.createIndex({ workflowInstanceId: 1 });
  await collection.createIndex(
    { workflowInstanceId: 1, nodeId: 1, pullRequestId: 1 },
    { unique: true, name: 'uniq_workflow_pr_handler' },
  );
  console.log('[Migration 007] Ensured indexes on workflowprhandlers');
}
