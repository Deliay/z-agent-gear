import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './013-tenant-id-backfill.js';

/**
 * 真库用例（T-MIG13-real）：验证 013 使用**真实集合名**（尤其 issue_workflow_triggers）、
 * 复制回填 tenantId、userId 保留、索引与幂等。集合名漂移（issueworkflowtriggers）由本用例兜底。
 */
describe('migration 013 tenantId backfill (real db)', () => {
  let server: MongoMemoryServer;
  const names = migration.TENANT_ID_COLLECTIONS.map((target) => target.collection);

  beforeAll(async () => {
    mongoose.set('autoIndex', false);
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri('agent-gear-tenant-013-test'));
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.db?.dropDatabase();
  });

  const db = () => mongoose.connection.db!;

  it('backfills every real collection including issue_workflow_triggers', async () => {
    expect(names).toHaveLength(19);
    expect(names).toContain('issue_workflow_triggers');
    expect(names).not.toContain('issueworkflowtriggers');

    for (const name of names) {
      await db().collection(name).insertOne({ userId: 'user-1', name: `row-${name}` });
      await db().collection(name).insertOne({ name: `no-owner-${name}` });
    }

    await migration.run();

    for (const name of names) {
      const owned = await db().collection(name).findOne({ userId: 'user-1' });
      expect(owned, name).toMatchObject({ userId: 'user-1', tenantId: 'user-1' });
      const orphan = await db().collection(name).findOne({ name: `no-owner-${name}` });
      expect(orphan?.tenantId ?? null, name).toBeNull();
    }

    // 集合名未漂移：不产生脏空集合
    const dirty = await db().listCollections({ name: 'issueworkflowtriggers' }).toArray();
    expect(dirty).toHaveLength(0);

    // 真实集合已建 tenantId 索引
    const indexes = await db().collection('issue_workflow_triggers').indexes();
    expect(indexes.some((index) => index.key?.tenantId === 1)).toBe(true);
  });

  it('is idempotent: second run keeps values and does not duplicate rows', async () => {
    for (const name of names) {
      await db().collection(name).insertOne({ userId: 'user-1', name: `row-${name}` });
    }

    await migration.run();
    const firstPass = await db().collection('sessions').findOne({ userId: 'user-1' });

    await migration.run();
    const secondPass = await db().collection('sessions').findOne({ userId: 'user-1' });

    expect(secondPass).toEqual(firstPass);
    expect(await db().collection('sessions').countDocuments({ userId: 'user-1' })).toBe(1);
    for (const name of names) {
      expect(await db().collection(name).countDocuments({ userId: 'user-1' })).toBe(1);
    }
  });
});
