import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './022-session-archive-indexes.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-022-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const db = () => mongoose.connection.db!;
const sessions = () => db().collection('sessions');

beforeEach(async () => {
  await sessions().drop().catch(() => undefined);
});

describe('migration 022 session archive indexes', () => {
  it('T-MIG22: 创建归档列表与工作区连带匹配两索引', async () => {
    await migration.createSessionArchiveIndexes();
    const indexes = await sessions().indexes();
    const byName = new Map(indexes.map((index) => [index.name, index]));

    expect(byName.get('session_user_archived_created')).toMatchObject({
      key: { userId: 1, archivedAt: 1, createdAt: -1 },
    });
    expect(byName.get('session_controller_workspace')).toMatchObject({
      key: { controllerId: 1, controllerWorkspaceId: 1 },
    });
  });

  it('T-MIG22: 迁移重跑幂等（不报错、索引数量与定义不变）', async () => {
    await migration.run();
    const first = (await sessions().indexes()).map((index) => index.name).sort();

    await expect(migration.run()).resolves.toBeUndefined();
    const second = (await sessions().indexes()).map((index) => index.name).sort();

    expect(second).toEqual(first);
    expect(first).toHaveLength(3); // _id_ + 2
    expect(first).toContain('session_user_archived_created');
    expect(first).toContain('session_controller_workspace');
  });

  it('T-MIG22: 兼容 Mongoose autoIndex 抢先建出的同键默认名索引（替换不冲突）', async () => {
    await sessions().createIndex({ controllerId: 1, controllerWorkspaceId: 1 });

    await expect(migration.createSessionArchiveIndexes()).resolves.toBeUndefined();

    const indexes = await sessions().indexes();
    const byKey = indexes.find(
      (index) =>
        JSON.stringify(index.key) === JSON.stringify({ controllerId: 1, controllerWorkspaceId: 1 }),
    );
    expect(byKey?.name).toBe('session_controller_workspace');
  });
});
