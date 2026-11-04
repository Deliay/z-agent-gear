import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './022-cloud-storage-fork.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-022-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const storages = () => mongoose.connection.db!.collection('cloudstorages');

beforeEach(async () => {
  await storages().drop().catch(() => undefined);
});

function doc(overrides: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    name: 'my-data',
    nameKey: 'my-data',
    sizeGi: 10,
    status: 'IDLE',
    tenantId: new mongoose.Types.ObjectId(),
    resourceWorkspaceId: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
    pvcName: 'zag-storage-x',
    destroyedAt: null,
    ...overrides,
  };
}

describe('migration 022 cloud storage fork index', () => {
  it('T-MIG-CS4: 按规格创建 fork 来源部分索引', async () => {
    await migration.run();
    const index = (await storages().indexes()).find(
      (entry) => entry.name === 'cloud_storage_fork_source',
    );
    expect(index).toMatchObject({
      key: { resourceWorkspaceId: 1, forkedFromStorageId: 1 },
      partialFilterExpression: { forkedFromStorageId: { $type: 'objectId' } },
    });
  });

  it('T-MIG-CS5: 重跑幂等（索引数量不变）', async () => {
    await migration.run();
    const first = (await storages().indexes()).map((entry) => entry.name).sort();
    await expect(migration.run()).resolves.toBeUndefined();
    const second = (await storages().indexes()).map((entry) => entry.name).sort();
    expect(second).toEqual(first);
  });

  it('T-MIG-CS6: 非 fork 行（forkedFromStorageId 缺失/null）不占索引', async () => {
    await migration.run();
    await expect(storages().insertOne(doc())).resolves.toBeDefined();
    await expect(
      storages().insertOne(doc({ forkedFromStorageId: null, nameKey: 'b' })),
    ).resolves.toBeDefined();
  });
});
