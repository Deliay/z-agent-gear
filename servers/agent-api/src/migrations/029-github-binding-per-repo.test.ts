import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './029-github-binding-per-repo.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-029-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const db = () => mongoose.connection.db!;
const bindings = () => db().collection('cloud_host_github_bindings');

beforeEach(async () => {
  await bindings().drop().catch(() => undefined);
});

function doc(overrides: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    tenantId: new mongoose.Types.ObjectId(),
    controllerId: new mongoose.Types.ObjectId(),
    accountId: new mongoose.Types.ObjectId(),
    repoFullName: 'owner/repo',
    targetPath: '/home/worker/workspace/repo',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function seedLegacyIndex(): Promise<void> {
  await bindings().createIndex({ controllerId: 1 }, { unique: true });
}

describe('migration 029-github-binding-per-repo', () => {
  it('T-MIG-GB1: 建组合唯一索引并删除旧 controllerId_1', async () => {
    await seedLegacyIndex();
    await migration.run();

    const indexes = await bindings().indexes();
    const byName = new Map(indexes.map((index) => [index.name, index]));
    expect(byName.get('uniq_cloud_host_github_binding')).toMatchObject({
      key: { controllerId: 1, repoFullName: 1 },
      unique: true,
    });
    expect(byName.has('controllerId_1')).toBe(false);
  });

  it('T-MIG-GB2: 幂等重跑（索引定义不变、旧索引缺失不报错）', async () => {
    await migration.run();
    const first = (await bindings().indexes()).map((index) => index.name).sort();
    await expect(migration.run()).resolves.toBeUndefined();
    const second = (await bindings().indexes()).map((index) => index.name).sort();
    expect(second).toEqual(first);
  });

  it('T-MIG-GB3: 存量单行兼容 + 同机多项目可共存（同仓库仍唯一）', async () => {
    await seedLegacyIndex();
    const controllerId = new mongoose.Types.ObjectId();
    await bindings().insertOne(doc({ controllerId, repoFullName: 'owner/a' }));

    await migration.run();

    await expect(
      bindings().insertOne(doc({ controllerId, repoFullName: 'owner/b' })),
    ).resolves.toMatchObject({ acknowledged: true });

    await expect(
      bindings().insertOne(doc({ controllerId, repoFullName: 'owner/a' })),
    ).rejects.toThrow(/duplicate key/i);
  });
});
