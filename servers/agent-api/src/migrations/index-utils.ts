import mongoose from 'mongoose';

type Collection = ReturnType<typeof mongoose.connection.collection>;
type IndexKeys = Parameters<Collection['createIndex']>[0];
type IndexOptions = NonNullable<Parameters<Collection['createIndex']>[1]> & { name: string };

interface IndexInfo {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
}

/** 把索引键 / 部分过滤表达式归一为可比较签名（顺序无关）。 */
function signature(value: Record<string, unknown> | undefined): string {
  if (!value) return '';
  return Object.keys(value)
    .sort()
    .map((key) => `${key}=${JSON.stringify(value[key])}`)
    .join(',');
}

function sameIndexOptions(index: IndexInfo, options: IndexOptions): boolean {
  return (
    (index.unique === true) === (options.unique === true) &&
    signature(index.partialFilterExpression) ===
      signature(options.partialFilterExpression as Record<string, unknown> | undefined)
  );
}

async function listIndexes(collection: Collection): Promise<IndexInfo[]> {
  try {
    return (await collection.indexes()) as unknown as IndexInfo[];
  } catch (err) {
    // 集合尚未创建时 listIndexes 抛 NamespaceNotFound（26），等价于「没有任何索引」
    const code = (err as { code?: number }).code;
    if (code === 26 || /ns not found|namespace not found/i.test((err as Error).message ?? '')) {
      return [];
    }
    throw err;
  }
}

/**
 * MongoDB 为未命名索引生成的默认名（如 `userId_1` / `tenantId_1_workspaceId_1`）。
 * 只有默认名索引才视为 Mongoose `autoIndex` 抢先建出的同构索引，可安全替换。
 */
function defaultIndexName(keys: Record<string, unknown>): string {
  return Object.entries(keys)
    .map(([field, direction]) => `${field}_${String(direction)}`)
    .join('_');
}

/**
 * 幂等建索引，并兼容 Mongoose `autoIndex` 用默认名抢先建出的同键索引。
 *
 * MongoDB 不允许同一 key pattern 以两个不同名字存在（IndexOptionsConflict，code 85），
 * 而 Mongoose 字段级 `index: true` 会生成 `userId_1` 这类默认名，与迁移声明的固定名冲突。
 * 这里先删除同键的「默认名」旧索引（或同名但定义已变的索引），再按固定名重建；
 * 索引已完全一致时直接跳过。非默认名的同键索引（如运维手工建的）不会被误删，
 * 由 createIndex 照常暴露冲突。
 */
export async function ensureIndex(
  collection: Collection,
  keys: IndexKeys,
  options: IndexOptions,
): Promise<void> {
  const keySignature = signature(keys as Record<string, unknown>);
  const autoName = defaultIndexName(keys as Record<string, unknown>);
  const existing = await listIndexes(collection);

  const clashes = existing.filter((index) => {
    if (index.name === '_id_') return false;
    return index.name === options.name || signature(index.key) === keySignature;
  });

  const exact = clashes.find(
    (index) =>
      index.name === options.name &&
      signature(index.key) === keySignature &&
      sameIndexOptions(index, options),
  );
  if (exact) return;

  for (const index of clashes) {
    if (!index.name) continue;
    if (index.name === options.name || index.name === autoName) {
      await collection.dropIndex(index.name);
    }
  }

  await collection.createIndex(keys, options);
}
