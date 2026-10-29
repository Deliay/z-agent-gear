import mongoose from 'mongoose';

export const name = '017-normalize-string-workspace-id';

/**
 * `workspaceId` 是 String 口径的集合（F8）。
 *
 * 015 早期版本回填时对所有集合都写入 `ObjectId`，导致这两个集合的存量行
 * 在 workspace-scope 注入字符串过滤（`{ workspaceId: { $in: ['<id>'] } }`）后
 * 永远匹配不到 → 线上表现为「GitHub 账号全部消失」「Commit 设置显示未设置」。
 *
 * 本迁移把历史 `ObjectId` 值归一为 String，并合并重复行（转换后可能撞唯一索引）。
 */
export const STRING_WORKSPACE_ID_TARGETS = [
  {
    collection: 'githubaccounts',
    field: 'workspaceId',
    /** 唯一索引 {tenantId, workspaceId, githubUserId} 的其余维度 */
    dedupeKeys: ['tenantId', 'githubUserId'],
  },
  {
    collection: 'user_commit_settings',
    field: 'workspaceId',
    /** 唯一索引 {workspaceId} */
    dedupeKeys: [],
  },
] as const;

export interface NormalizeResult {
  /** ObjectId → String 的行数 */
  converted: number;
  /** 已存在等价 String 行、被删除的历史行数 */
  deduped: number;
}

type Collection = ReturnType<typeof mongoose.connection.collection>;
type Target = (typeof STRING_WORKSPACE_ID_TARGETS)[number];

/**
 * 幂等归一化：逐行把 ObjectId 工作区字段转为字符串。
 *
 * 去重策略：转换前先查同键（workspaceId + dedupeKeys）是否已有 String 行，
 * 有则保留 String 行（迁移失败后由应用新写入，数据更新）、删除 ObjectId 旧行。
 * 处理顺序按 `updatedAt` 倒序，保证同一批 ObjectId 行里最新的一条胜出。
 */
export async function normalizeStringWorkspaceIds(): Promise<Record<string, NormalizeResult>> {
  const results: Record<string, NormalizeResult> = {};
  for (const target of STRING_WORKSPACE_ID_TARGETS) {
    const collection = mongoose.connection.collection(target.collection);
    results[target.collection] = await normalizeCollection(collection, target);
  }
  return results;
}

async function normalizeCollection(collection: Collection, target: Target): Promise<NormalizeResult> {
  const projection: Record<string, 1> = { _id: 1, [target.field]: 1 };
  for (const key of target.dedupeKeys) projection[key] = 1;

  const rows = await collection
    .find({ [target.field]: { $type: 'objectId' } }, { projection })
    .sort({ updatedAt: -1, _id: -1 })
    .toArray();

  let converted = 0;
  let deduped = 0;
  for (const row of rows) {
    const workspaceId = String(row[target.field]);
    const conflictFilter: Record<string, unknown> = { [target.field]: workspaceId };
    for (const key of target.dedupeKeys) {
      conflictFilter[key] = row[key] ?? null;
    }
    const existing = await collection.findOne(conflictFilter, { projection: { _id: 1 } });
    if (existing) {
      await collection.deleteOne({ _id: row._id });
      deduped += 1;
      continue;
    }
    await collection.updateOne({ _id: row._id }, { $set: { [target.field]: workspaceId } });
    converted += 1;
  }
  return { converted, deduped };
}

/**
 * 迁移 017：清理 015 早期版本写入的 ObjectId `workspaceId` 脏数据。
 *
 * 可重复执行：无 ObjectId 行时零变更；存在 String 行时保留 String 行并删除历史重复行。
 */
export async function run(): Promise<void> {
  const results = await normalizeStringWorkspaceIds();
  for (const [collection, result] of Object.entries(results)) {
    console.log(
      `[Migration 017] ${collection}: converted ${result.converted}, deduped ${result.deduped}`,
    );
  }
  console.log('[Migration 017] completed');
}
