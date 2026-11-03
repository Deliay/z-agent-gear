/**
 * 多租户上线后遗留索引 / 脏数据 API 回归（DB 状态断言）。
 *
 * 覆盖：
 * - PR #358：`user_commit_settings` 的固定名索引必须存在，Mongoose 默认名索引不得残留
 *   （迁移 011/015 曾因 IndexOptionsConflict(code 85) 启动失败）。
 * - PR #359：`githubaccounts` / `user_commit_settings.workspaceId` 必须为 String，
 *   历史 ObjectId 行由迁移 017 归一（此处锁定「不再出现 ObjectId」的不变量）。
 * - PR #361：`mcpservers` / `githubaccounts` 不得残留无租户维度的唯一索引
 *   （`{userId,name}` / `{userId,githubUserId}`）。
 *
 * 依赖：`MONGODB_URI`（与 Aspire 同一实例）。集合由服务启动时的模型/迁移创建。
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';

const HAS_MONGO = Boolean(process.env.MONGODB_URI);

interface IndexInfo {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
}

function keySignature(keys: Record<string, unknown>): string {
  return Object.keys(keys)
    .sort()
    .map((field) => `${field}:${String(keys[field])}`)
    .join(',');
}

async function mongoDb(): Promise<mongoose.mongo.Db> {
  if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI!);
  return mongoose.connection.db!;
}

async function listIndexes(collection: string): Promise<IndexInfo[]> {
  const db = await mongoDb();
  try {
    return (await db.collection(collection).indexes()) as unknown as IndexInfo[];
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 26) return [];
    throw err;
  }
}

function uniqueIndexesWithKeys(indexes: IndexInfo[], keys: Record<string, unknown>): IndexInfo[] {
  const signature = keySignature(keys);
  return indexes.filter(
    (index) => index.unique === true && keySignature(index.key ?? {}) === signature,
  );
}

describe.skipIf(!HAS_MONGO)('多租户上线回归：索引与 workspaceId 类型不变量', () => {
  it('T-IDX-API1: user_commit_settings 只保留固定名 workspace 唯一索引', async () => {
    const indexes = await listIndexes('user_commit_settings');
    expect(
      uniqueIndexesWithKeys(indexes, { workspaceId: 1 }).some(
        (index) => index.name === 'uniq_workspace_commit_setting',
      ),
      `期望 uniq_workspace_commit_setting，实际：${JSON.stringify(indexes)}`,
    ).toBe(true);

    // 迁移 015 已下线 userId 维度；默认名 / 旧固定名都必须消失
    for (const legacyName of [
      'userId_1',
      'workspaceId_1',
      'uniq_user_commit_setting',
      'tenantId_1_userId_1',
    ]) {
      expect(indexes.some((index) => index.name === legacyName), `残留旧索引 ${legacyName}`).toBe(
        false,
      );
    }
  });

  it('T-IDX-API2: mcpservers / githubaccounts 不残留无租户维度唯一索引', async () => {
    const mcpIndexes = await listIndexes('mcpservers');
    expect(
      uniqueIndexesWithKeys(mcpIndexes, { userId: 1, name: 1 }),
      `mcpservers 残留 {userId,name} 唯一索引：${JSON.stringify(mcpIndexes)}`,
    ).toHaveLength(0);
    expect(
      uniqueIndexesWithKeys(mcpIndexes, { tenantId: 1, userId: 1, name: 1 }),
      'mcpservers 缺少 {tenantId,userId,name} 唯一索引',
    ).not.toHaveLength(0);

    const githubIndexes = await listIndexes('githubaccounts');
    expect(
      uniqueIndexesWithKeys(githubIndexes, { userId: 1, githubUserId: 1 }),
      `githubaccounts 残留 {userId,githubUserId} 唯一索引：${JSON.stringify(githubIndexes)}`,
    ).toHaveLength(0);
    expect(
      uniqueIndexesWithKeys(githubIndexes, { tenantId: 1, workspaceId: 1, githubUserId: 1 }),
      'githubaccounts 缺少 {tenantId,workspaceId,githubUserId} 唯一索引',
    ).not.toHaveLength(0);
  });

  it('T-IDX-API3: workspaceId 不再出现 BSON ObjectId 脏数据', async () => {
    const db = await mongoDb();
    for (const collection of ['githubaccounts', 'user_commit_settings']) {
      const count = await db
        .collection(collection)
        .countDocuments({ workspaceId: { $type: 'objectId' } });
      expect(count, `${collection}.workspaceId 仍有 ${count} 条 ObjectId 行`).toBe(0);
    }
  });
});
