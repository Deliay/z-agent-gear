import * as backfill013 from './013-tenant-id-backfill.js';

export const name = '014-tenant-id-rebackfill';

/**
 * 014-tenant-id-rebackfill：补齐 013 之后由 controller-api 等写方新增的存量行。
 *
 * 背景：`controllers` / `mcpservers` / `sessions` 等集合由 controller-api 与 agent-api 共同写入；
 * 修复 controller-api tenantId 双写前产生的行没有 `tenantId`，而 013 已在启动时执行过（账本不会重跑）。
 * 本迁移复用 013 的幂等回填语义（只补齐缺失、userId 保留、索引幂等），修复历史数据。
 *
 * 说明：本迁移与 013 使用同一份集合清单/实现，保证集合名与大口径单一来源。
 */
export async function run(): Promise<void> {
  await backfill013.run();
  console.log('[Migration 014] tenantId re-backfill completed (controller-api historical rows)');
}
