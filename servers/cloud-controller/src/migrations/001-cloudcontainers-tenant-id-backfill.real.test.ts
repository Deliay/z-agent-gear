import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './001-cloudcontainers-tenant-id-backfill.js';

/**
 * 真库用例（T-MIG-CC1）：与 admin-api 014 同口径，覆盖「复制而非 rename、幂等、索引」。
 */
describe('migration 001 cloudcontainers tenantId (real db)', () => {
  let server: MongoMemoryServer;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri('agent-gear-cloud-controller-test'));
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.collection('cloudcontainers').deleteMany({});
  });

  const collection = () => mongoose.connection.collection('cloudcontainers');

  it('backfills tenantId=userId while keeping userId and leaving other rows untouched', async () => {
    await collection().insertMany([
      { name: 'c1', userId: 'user-1', purpose: 'harness' },
      { name: 'c2', userId: 'user-2', tenantId: 'tenant-2', purpose: 'harness' },
      { name: 'c3', purpose: 'idle' },
      { name: 'c4', userId: '', purpose: 'harness' },
    ]);

    await migration.run();

    const rows = await collection().find({}).sort({ _id: 1 }).toArray();
    const byUser = (id: string) => rows.find((row) => row.userId === id);
    expect(byUser('user-1')).toMatchObject({ userId: 'user-1', tenantId: 'user-1' });
    expect(byUser('user-2')).toMatchObject({ userId: 'user-2', tenantId: 'tenant-2' });
    expect(rows.find((row) => !row.userId)).not.toHaveProperty('tenantId');
    expect(rows.find((row) => row.userId === '')?.tenantId ?? null).toBeNull();

    const indexes = await collection().indexes();
    expect(indexes.some((index) => index.key && index.key.tenantId === 1)).toBe(true);
  });

  it('is idempotent: second run changes nothing', async () => {
    await collection().insertOne({ name: 'c1', userId: 'user-1', purpose: 'harness' });

    await migration.run();
    const afterFirst = await collection().findOne({ userId: 'user-1' });

    await migration.run();
    const afterSecond = await collection().findOne({ userId: 'user-1' });

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond).toMatchObject({ tenantId: 'user-1' });
  });
});
