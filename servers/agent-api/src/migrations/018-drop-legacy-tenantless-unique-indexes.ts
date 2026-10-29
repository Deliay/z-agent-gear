import mongoose from 'mongoose';

export const name = '018-drop-legacy-tenantless-unique-indexes';

export interface LegacyIndexTarget {
  collection: string;
  /** 多租户改造前的旧唯一索引键（Mongoose 默认名时代遗留） */
  keys: Record<string, 1>;
  /** 新唯一索引（同一集合）的说明，仅用于日志 */
  replacedBy: string;
}

/**
 * 多租户改造遗留的「无租户维度」唯一索引。
 *
 * 一期把唯一键从 `{userId,...}` 扩成 `{tenantId,userId,...}` 时只新增、没删除旧索引，
 * 二期团队租户下同一用户在不同租户/工作区需要同名资源，旧索引会误判重复：
 *
 * - `mcpservers`：`{userId,name}`（默认名 `userId_1_name_1`）
 *   → 现在 `{tenantId,userId,name}`，同一用户在不同租户下需可同名
 * - `githubaccounts`：`{userId,githubUserId}`（默认名 `userId_1_githubUserId_1`）
 *   → 现在 `{tenantId,workspaceId,githubUserId}`，同一 GitHub 账号可绑定多个工作区
 */
export const LEGACY_UNIQUE_INDEXES: readonly LegacyIndexTarget[] = [
  {
    collection: 'mcpservers',
    keys: { userId: 1, name: 1 },
    replacedBy: '{ tenantId, userId, name }',
  },
  {
    collection: 'githubaccounts',
    keys: { userId: 1, githubUserId: 1 },
    replacedBy: '{ tenantId, workspaceId, githubUserId }',
  },
];

function keySignature(keys: Record<string, unknown>): string {
  return Object.keys(keys)
    .sort()
    .map((field) => `${field}:${String(keys[field])}`)
    .join(',');
}

/**
 * 迁移 018：删除多租户改造前遗留的唯一索引（幂等）。
 *
 * 按 key pattern 匹配（不依赖具体索引名），已是当前索引规则的索引不会命中；
 * 索引不存在时零操作，可重复执行。
 */
export async function run(): Promise<void> {
  for (const target of LEGACY_UNIQUE_INDEXES) {
    const collection = mongoose.connection.collection(target.collection);
    let indexes: Array<{ name?: string; key: Record<string, unknown> }>;
    try {
      indexes = (await collection.indexes()) as unknown as typeof indexes;
    } catch (err) {
      // 集合尚未创建时 listIndexes 抛 NamespaceNotFound（26），等价于无旧索引
      const code = (err as { code?: number }).code;
      if (code === 26 || /ns does not exist|ns not found/i.test((err as Error).message ?? '')) {
        continue;
      }
      throw err;
    }
    const legacySignature = keySignature(target.keys);
    for (const index of indexes) {
      if (!index.name || index.name === '_id_') continue;
      if (keySignature(index.key as Record<string, unknown>) !== legacySignature) continue;
      await collection.dropIndex(index.name);
      console.log(
        `[Migration 018] dropped legacy unique index ${target.collection}.${index.name} (replaced by ${target.replacedBy})`,
      );
    }
  }
  console.log('[Migration 018] completed');
}
