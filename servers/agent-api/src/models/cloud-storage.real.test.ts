import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { CloudStorage } from './cloud-storage.js';

/**
 * T-CS-AR2-RT：归档补偿字段真库 round-trip。
 *
 * Mongoose 默认 strict 会剥离 schema 未声明字段；本用例直接复刻
 * `handleArchiveCallback` 的 `findOneAndUpdate($set: { currentArchive })` 写法，
 * 断言 `sourcePvcReleased:false` 真正落库并可读回（防止仅 mock $set 的假绿）。
 */
let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-cloud-storage-real-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await CloudStorage.deleteMany({});
});

function baseDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    name: 'my-data',
    nameKey: 'my-data',
    sizeGi: 10,
    status: 'ARCHIVING' as const,
    tenantId: new mongoose.Types.ObjectId(),
    resourceWorkspaceId: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
    pvcName: 'zag-storage-real',
    attachedCloudHostId: null,
    destroyedAt: null,
    ...overrides,
  };
}

describe('cloudstorages currentArchive real round-trip', () => {
  it('T-CS-AR2-RT: $set currentArchive.sourcePvcReleased=false 落库后读回仍为 false', async () => {
    const id = new mongoose.Types.ObjectId();
    await CloudStorage.create(baseDoc({ _id: id }));

    const archive = {
      archiveId: 'a1',
      containerId: 'container-1',
      cloudHostId: null,
      cloudHostName: 'my-pc',
      fileName: 'my-pc-20261102-153012.tar.gz2',
      path: '/archive/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbb/my-pc-20261102-153012.tar.gz2',
      status: 'SUCCEEDED',
      usageBytes: 1024,
      startedAt: new Date('2026-11-02T15:00:00Z'),
      finishedAt: new Date('2026-11-02T15:10:00Z'),
      failureReason: null,
      sourcePvcReleased: false,
    };

    await CloudStorage.findOneAndUpdate(
      { _id: id, status: 'ARCHIVING' },
      { $set: { status: 'ARCHIVED', billingRate: 'HALF', currentArchive: archive } },
      { returnDocument: 'after' },
    );

    // 直查 raw DB，绕过 Mongoose 读时转换，确认字段未被 strict 剥离。
    const raw = await mongoose.connection.db!
      .collection('cloudstorages')
      .findOne({ _id: id });
    expect(raw?.currentArchive?.sourcePvcReleased).toBe(false);

    const readBack = await CloudStorage.findById(id).lean();
    expect(readBack?.currentArchive?.sourcePvcReleased).toBe(false);
  });
});
