import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './020-cloud-storage-indexes.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-020-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const db = () => mongoose.connection.db!;
const storages = () => db().collection('cloudstorages');

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
    attachedCloudHostId: null,
    destroyedAt: null,
    ...overrides,
  };
}

describe('migration 020 cloud storage indexes', () => {
  it('T-MIG-CS1: 按规格创建 5 个索引（含 2 个 partial unique）', async () => {
    await migration.createCloudStorageIndexes();
    const indexes = await storages().indexes();
    const byName = new Map(indexes.map((index) => [index.name, index]));

    expect(byName.get('uniq_cloud_storage_workspace_name')).toMatchObject({
      key: { resourceWorkspaceId: 1, nameKey: 1 },
      unique: true,
      partialFilterExpression: { destroyedAt: null },
    });
    expect(byName.get('uniq_cloud_storage_attached_host')).toMatchObject({
      key: { attachedCloudHostId: 1 },
      unique: true,
      partialFilterExpression: { attachedCloudHostId: { $type: 'objectId' } },
    });
    expect(byName.get('cloud_storage_tenant')).toMatchObject({ key: { tenantId: 1 } });
    expect(byName.get('cloud_storage_workspace_status')).toMatchObject({
      key: { resourceWorkspaceId: 1, status: 1 },
    });
    expect(byName.get('cloud_storage_status_billing')).toMatchObject({
      key: { status: 1, billingStartedAt: 1 },
    });
  });

  it('T-MIG-CS2: 重跑幂等（索引数量与定义不变、不报错）', async () => {
    await migration.createCloudStorageIndexes();
    const first = (await storages().indexes()).map((index) => index.name).sort();
    await expect(migration.createCloudStorageIndexes()).resolves.toBeUndefined();
    const second = (await storages().indexes()).map((index) => index.name).sort();
    expect(second).toEqual(first);
    expect(first).toHaveLength(6); // _id_ + 5
  });

  it('T-MIG-CS3: {resourceWorkspaceId,nameKey} 唯一（destroyedAt=null）与 attachedCloudHostId 唯一生效', async () => {
    await migration.createCloudStorageIndexes();
    const workspaceId = new mongoose.Types.ObjectId();
    const tenantId = new mongoose.Types.ObjectId();
    await storages().insertOne(doc({ resourceWorkspaceId: workspaceId, tenantId }));

    await expect(
      storages().insertOne(doc({ resourceWorkspaceId: workspaceId, tenantId, name: 'MY-DATA' })),
    ).rejects.toMatchObject({ code: 11000 });

    // 不同工作区同名允许
    await expect(
      storages().insertOne(doc({ resourceWorkspaceId: new mongoose.Types.ObjectId(), tenantId })),
    ).resolves.toBeDefined();

    // 已销毁记录释放名称
    await expect(
      storages().insertOne(
        doc({
          resourceWorkspaceId: workspaceId,
          tenantId,
          destroyedAt: new Date(),
        }),
      ),
    ).resolves.toBeDefined();

    const hostId = new mongoose.Types.ObjectId();
    await expect(
      storages().insertOne(doc({ attachedCloudHostId: hostId, nameKey: 'a' })),
    ).resolves.toBeDefined();
    await expect(
      storages().insertOne(doc({ attachedCloudHostId: hostId, nameKey: 'b' })),
    ).rejects.toMatchObject({ code: 11000 });

    // null 不参与唯一约束
    await expect(
      storages().insertOne(doc({ attachedCloudHostId: null, nameKey: 'c' })),
    ).resolves.toBeDefined();
    await expect(
      storages().insertOne(doc({ attachedCloudHostId: null, nameKey: 'd' })),
    ).resolves.toBeDefined();
  });
});
