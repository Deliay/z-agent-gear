import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';
import { ensureIndex } from './index-utils.js';

export const name = '021-workflow-interrupt-retry';

const log = logger.child({ component: 'migration/021-workflow-interrupt-retry' });

type Collection = ReturnType<typeof mongoose.connection.collection>;

/** 中断自动重试调度扫描索引（与 `models/workflow-instance.ts` 声明一致） */
export const WORKFLOW_INTERRUPT_RETRY_INDEX_NAME = 'workflow_instance_node_next_retry';

/**
 * 迁移 021：`fallbackSent`（一次性兜底）→ 分段自动重试字段。
 *
 * 1. `fallbackSent=true` 的节点转换 `retryCount=1`（已用过一次兜底）；
 * 2. 其余缺 `retryCount` 的节点补 `0`——**必做**：新排期 CAS 以 `retryCount` 快照为条件，
 *    缺失字段会让旧实例永不命中（重试静默失效）；
 * 3. 清除旧字段 `fallbackSent`；
 * 4. 兜底创建 `nodes.nextRetryAt` 部分索引（生产 `autoIndex=false`）。
 *
 * 全流程幂等：重跑不会改动已完成转换的数据。
 */
export async function run(): Promise<void> {
  const collection = mongoose.connection.collection('workflowinstances') as Collection;

  // 阶段一：fallbackSent=true → retryCount=1
  const converted = await collection.updateMany(
    { 'nodes.fallbackSent': true },
    { $set: { 'nodes.$[n].retryCount': 1 } },
    { arrayFilters: [{ 'n.fallbackSent': true }] },
  );

  // 阶段二：缺 retryCount → 0（刚转换的节点保持 1）
  // 注意必须用 $elemMatch：`{'nodes.retryCount': {$exists:false}}` 的语义是
  // 「没有任何数组元素带该字段」，阶段一已回填的节点会让整文档不匹配而漏补其他节点
  const backfilled = await collection.updateMany(
    { nodes: { $elemMatch: { retryCount: { $exists: false } } } },
    { $set: { 'nodes.$[n].retryCount': 0 } },
    { arrayFilters: [{ 'n.retryCount': { $exists: false } }] },
  );

  // 阶段三：清除旧字段
  const cleaned = await collection.updateMany(
    { nodes: { $elemMatch: { fallbackSent: { $exists: true } } } },
    { $unset: { 'nodes.$[n].fallbackSent': '' } },
    { arrayFilters: [{ 'n.fallbackSent': { $exists: true } }] },
  );

  await createWorkflowInterruptRetryIndex();

  log.info(
    {
      converted: converted.modifiedCount,
      backfilled: backfilled.modifiedCount,
      cleaned: cleaned.modifiedCount,
    },
    'migration completed',
  );
}

/** 幂等创建 `nodes.nextRetryAt` 部分索引（固定名，兼容 Mongoose 默认名抢先建出的同键索引） */
export async function createWorkflowInterruptRetryIndex(): Promise<void> {
  const collection = mongoose.connection.collection('workflowinstances') as Collection;
  await ensureIndex(
    collection,
    { 'nodes.nextRetryAt': 1 } as never,
    {
      name: WORKFLOW_INTERRUPT_RETRY_INDEX_NAME,
      partialFilterExpression: { 'nodes.nextRetryAt': { $exists: true } },
    } as never,
  );
}
