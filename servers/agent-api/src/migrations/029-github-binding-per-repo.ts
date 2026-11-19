import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';
import { ensureIndex } from './index-utils.js';

const log = logger.child({ component: 'migration/029-github-binding-per-repo' });

export const name = '029-github-binding-per-repo';

type Collection = ReturnType<typeof mongoose.connection.collection>;

/** 一机多项目绑定：`{controllerId, repoFullName}` 组合唯一。 */
export const CLOUD_HOST_GITHUB_BINDING_INDEX = {
  collection: 'cloud_host_github_bindings',
  keys: { controllerId: 1, repoFullName: 1 },
  options: { unique: true, name: 'uniq_cloud_host_github_binding' },
} as const;

/** 旧索引名（`controllerId` 单字段唯一，随一机多项目废弃）。 */
export const LEGACY_CONTROLLER_INDEX_NAME = 'controllerId_1';

/**
 * 029-github-binding-per-repo：`cloud_host_github_bindings` 从「一机一项目」升级为「一机多项目」。
 *
 * 顺序硬约束（D9 / 提案 §4.1）：
 * 1. 先建 `{controllerId, repoFullName}` 唯一索引（存量每机至多一行，天然满足组合唯一，零回填）；
 * 2. 建成功后再删旧 `controllerId_1` 唯一索引（不存在则忽略）。
 * 绝不先删后建：建索引失败时旧唯一约束仍在，不会出现「无约束窗口」。
 *
 * 迁移随启动自动执行、失败不阻断（沿用 runner 语义）；`ensureIndex` 幂等可重跑。
 */
export async function run(): Promise<void> {
  const collection = mongoose.connection.collection(
    CLOUD_HOST_GITHUB_BINDING_INDEX.collection,
  ) as Collection;

  await ensureIndex(
    collection,
    CLOUD_HOST_GITHUB_BINDING_INDEX.keys as never,
    CLOUD_HOST_GITHUB_BINDING_INDEX.options as never,
  );

  try {
    await collection.dropIndex(LEGACY_CONTROLLER_INDEX_NAME);
    log.info({ event: 'legacy_index_dropped' }, 'dropped legacy controllerId index');
  } catch (err) {
    const code = (err as { code?: number; codeName?: string }).code;
    const message = (err as Error).message ?? '';
    // 27 = IndexNotFound；26 = NamespaceNotFound（集合尚未创建）
    if (code === 27 || code === 26 || /index .*not found|ns not found/i.test(message)) {
      log.info({ event: 'legacy_index_absent' }, 'legacy controllerId index already absent');
    } else {
      throw err;
    }
  }
}
