import mongoose from 'mongoose';
import { TENANT_ID_COLLECTIONS } from '../migrations/013-tenant-id-backfill.js';
import { logger as rootLogger } from '../observability/logger.js';
import { Tenant } from '../models/tenant.js';
import { User } from '../models/user.js';

const logger = rootLogger.child({ component: 'tenant-self-check' });

/** 抽样上限（自检耗时不随数据量线性增长：带索引计数 + 限量抽样）。 */
export const SAMPLE_SIZE = 100;

export interface TenantSelfCheckResult {
  warnings: string[];
  elapsedMs: number;
  sampled: number;
  /** 各集合「缺 tenantId」行数 */
  collections: Record<string, number>;
}

/**
 * 启动后轻量异步自检（F9）：迁移完成后兜底观测，**只告警不阻断**。
 *
 * - `users` 缺 account / 缺 tenantId：带索引 countDocuments；
 * - 抽样 100 行校验 `tenantId == userId`、`name` 存在、租户文档存在；
 * - 19 个集合「缺 tenantId」行数（countDocuments）；
 * - 异常仅告警，不抛出（不阻塞服务就绪）。
 */
export async function runTenantSelfCheck(): Promise<TenantSelfCheckResult> {
  const started = Date.now();
  const warnings: string[] = [];

  try {
    const noAccount = await User.countDocuments({
      $or: [{ accountId: { $exists: false } }, { accountId: null }],
    });
    if (noAccount > 0) warnings.push(`users without account: ${noAccount}`);

    const noTenant = await User.countDocuments({
      $or: [{ tenantId: { $exists: false } }, { tenantId: null }],
    });
    if (noTenant > 0) warnings.push(`users without tenantId: ${noTenant}`);

    const sample = await User.find({})
      .select('_id name tenantId')
      .limit(SAMPLE_SIZE)
      .lean();

    let mismatch = 0;
    let nameMissing = 0;
    const tenantIds: unknown[] = [];
    for (const user of sample) {
      if (user.tenantId && String(user.tenantId) !== String(user._id)) mismatch += 1;
      if (!user.name) nameMissing += 1;
      if (user.tenantId) tenantIds.push(user.tenantId);
    }
    if (mismatch > 0) warnings.push(`sampled users with tenantId != userId: ${mismatch}`);
    if (nameMissing > 0) warnings.push(`sampled users without name: ${nameMissing}`);

    if (tenantIds.length > 0) {
      const found = await Tenant.countDocuments({ _id: { $in: tenantIds } });
      if (found < tenantIds.length) {
        warnings.push(`sampled users without tenant document: ${tenantIds.length - found}`);
      }
    }

    const collections: Record<string, number> = {};
    for (const target of TENANT_ID_COLLECTIONS) {
      const missing = await mongoose.connection
        .collection(target.collection)
        .countDocuments({ tenantId: { $exists: false } });
      collections[target.collection] = missing;
      if (missing > 0) warnings.push(`${target.collection} rows without tenantId: ${missing}`);
    }

    const elapsedMs = Date.now() - started;
    if (warnings.length > 0) {
      logger.warn({ warningCount: warnings.length, elapsedMs, warnings }, 'tenant self-check found warnings');
    } else {
      logger.info({ elapsedMs, sampled: sample.length }, 'tenant self-check ok');
    }
    return { warnings, elapsedMs, sampled: sample.length, collections };
  } catch (err) {
    const elapsedMs = Date.now() - started;
    logger.warn({ err }, 'tenant self-check skipped');
    return { warnings: [`self-check failed: ${(err as Error).message}`], elapsedMs, sampled: 0, collections: {} };
  }
}

/** 服务就绪后异步触发（`setImmediate` 不阻塞 listen）。 */
export function scheduleTenantSelfCheck(): void {
  setImmediate(() => {
    void runTenantSelfCheck().catch((err) => {
      logger.warn({ err }, 'tenant self-check failed');
    });
  });
}
