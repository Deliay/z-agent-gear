import mongoose from 'mongoose';
import { CloudContainer } from '../models/cloud-container.js';

export const name = '001-cloudcontainers-tenant-id-backfill';

/**
 * 001-cloudcontainers-tenant-id-backfill：为存量容器回填租户归属（多租户一期）。
 *
 * 口径（计划 Phase 8 / §3.2 裁决 4）：`tenantId` 为**复制新增**字段，personal 期恒等于
 * `userId`；原 `userId` 字段与筛选维度全保留，不做 rename。历史行在模型新增字段前不存在
 * `tenantId`，模型 `default: null` 之后新建但未携带归属的行则为 `null`——两种都视为「缺失」，
 * 统一由 `userId` 同值复制补齐（值为 String，直接同值复制）。
 *
 * 使用 MongoDB 聚合管线更新（单次 `updateMany`，不需要把文档拉回应用侧）：
 *   `{ userId 存在且非空, tenantId 缺失/null }` → `$set: { tenantId: '$userId' }`
 * 已回填（非 null）的行不再命中，因此幂等可重跑（重跑只补齐缺失）。
 *
 * 另显式创建 `{ tenantId: 1 }` 普通索引（幂等）：与模型 `index: true` 同口径，
 * 避免部署关闭 `autoIndex` 时索引缺失。
 */
export async function run(): Promise<void> {
  // 先回填再建索引：索引构建扫描的文档量不因回填而增加额外抖动。
  const result = await CloudContainer.updateMany(
    {
      userId: { $exists: true, $nin: [null, ''] },
      $or: [{ tenantId: { $exists: false } }, { tenantId: null }],
    },
    [{ $set: { tenantId: '$userId' } }],
  );
  console.log(
    `[Migration 001] backfilled cloudcontainers.tenantId: ${result.modifiedCount} document(s)`,
  );

  const collection = mongoose.connection.collection('cloudcontainers');
  await collection.createIndex({ tenantId: 1 });
  console.log('[Migration 001] Ensured index { tenantId: 1 } on cloudcontainers');
}
