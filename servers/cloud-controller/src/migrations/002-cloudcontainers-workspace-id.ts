import mongoose from 'mongoose';
import { resolveGlobalWorkspaceId } from '../services/workspace-resolver.js';

export const name = '002-cloudcontainers-workspace-id';

/** 缺失 `workspaceId`（字段不存在或为 null）的容器行。 */
const MISSING_WORKSPACE_ID: mongoose.mongo.Filter<mongoose.mongo.Document> = {
  $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }],
};

/**
 * 002-cloudcontainers-workspace-id：为存量容器回填租户工作区归属（多租户二期）。
 *
 * 口径（计划 Phase 7 / 契约附录 A.2.2）：`workspaceId` 为**复制新增**字段（String，`tenantId` 的
 * 同级维度），写方仍仅本服务（经 `startHarness` 下发）。历史行在模型新增字段前不存在该字段，
 * 模型 `default: null` 之后新建但未携带归属的行为 `null`——两者都视为「缺失」：
 *
 * 1. 按 `tenantId` 在**同库** `workspaces` 集合解析 `type:'global'` 的全局工作区回填
 *   （每租户恰一个，`tenantId` 兼容 ObjectId / String 两种存储口径）；
 * 2. 解析不到（租户缺全局工作区 / 租户不存在）→ `workspaceId` 置 `null` 并 warn（留档待人工/下次重试）；
 * 3. `tenantId` 缺失的行跳过、不改动（与迁移 001 的 `userId` 缺失行同口径，例如 idle 容器）。
 *
 * 已置非 null 的 `workspaceId` 行不再命中，因此幂等可重跑（重跑只补齐缺失，二次 run 数据零变更）。
 *
 * 另显式创建 `{ workspaceId: 1 }` 普通索引（幂等）：与模型 `index: true` 同口径，
 * 避免部署关闭 `autoIndex` 时索引缺失。
 */
export async function run(): Promise<void> {
  const collection = mongoose.connection.collection('cloudcontainers');

  // 先按缺失 workspaceId 的存量行聚合出涉及的租户（每租户只解析一次全局工作区）。
  const tenantValues = await collection.distinct('tenantId', MISSING_WORKSPACE_ID);

  let backfilled = 0;
  let unresolved = 0;
  let skipped = 0;

  for (const rawTenantId of tenantValues) {
    // tenantId 缺失的行（undefined 不会出现在 distinct 结果里，null/'' 会出现）：跳过，不改动。
    if (rawTenantId === null || rawTenantId === undefined || rawTenantId === '') {
      const result = await collection.countDocuments({
        $and: [MISSING_WORKSPACE_ID, { $or: [{ tenantId: { $exists: false } }, { tenantId: null }, { tenantId: '' }] }],
      });
      skipped += result;
      continue;
    }

    const tenantId = String(rawTenantId);
    // 查询条件用存储原值（ObjectId / String 均可精确命中），解析用字符串形态。
    const filter = { $and: [MISSING_WORKSPACE_ID, { tenantId: rawTenantId }] };

    let workspaceId: string | null = null;
    try {
      workspaceId = await resolveGlobalWorkspaceId(tenantId);
    } catch (err) {
      console.warn(
        `[Migration 002] 解析全局工作区异常（tenantId=${tenantId}）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (workspaceId) {
      const result = await collection.updateMany(filter, { $set: { workspaceId } });
      backfilled += result.modifiedCount;
      console.log(
        `[Migration 002] cloudcontainers.workspaceId ← ${workspaceId} (tenantId=${tenantId}, ${result.modifiedCount} document(s))`,
      );
    } else {
      const result = await collection.updateMany(filter, { $set: { workspaceId: null } });
      unresolved += result.modifiedCount;
      console.warn(
        `[Migration 002] 无法解析全局工作区，置 workspaceId=null (tenantId=${tenantId}, ${result.modifiedCount} document(s))`,
      );
    }
  }

  console.log(
    `[Migration 002] backfilled cloudcontainers.workspaceId: ${backfilled} document(s), ` +
      `unresolved: ${unresolved}, skipped(no tenantId): ${skipped}`,
  );

  await collection.createIndex({ workspaceId: 1 });
  console.log('[Migration 002] Ensured index { workspaceId: 1 } on cloudcontainers');
}
