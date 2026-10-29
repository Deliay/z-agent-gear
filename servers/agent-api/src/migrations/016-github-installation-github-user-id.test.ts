import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './016-github-installation-github-user-id.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-016-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const db = () => mongoose.connection.db!;

beforeEach(async () => {
  const collections = await db().collections();
  await Promise.all(
    collections.map(async (collection) => {
      await collection.deleteMany({});
      await collection.dropIndexes().catch(() => undefined);
    }),
  );
});

describe('migration 016 githubinstallations.githubUserId（T-MIG16）', () => {
  it('按 accountId 回填 githubUserId 并建索引；幂等重跑', async () => {
    const accountA = new mongoose.Types.ObjectId();
    const accountB = new mongoose.Types.ObjectId();
    await db().collection('githubaccounts').insertMany([
      { _id: accountA, githubUserId: 42, githubLogin: 'octo' },
      { _id: accountB, githubUserId: 43, githubLogin: 'cat' },
    ]);
    await db().collection('githubinstallations').insertMany([
      { accountId: accountA, installationId: 1, accountLogin: 'octo', accountType: 'User', repos: [] },
      { accountId: accountB, installationId: 2, accountLogin: 'cat', accountType: 'User', repos: [] },
      { accountId: new mongoose.Types.ObjectId(), installationId: 3, accountLogin: 'x', accountType: 'User', repos: [] },
    ]);

    await migration.run();

    const rows = await db()
      .collection('githubinstallations')
      .find({})
      .sort({ installationId: 1 })
      .toArray();
    expect(rows[0].githubUserId).toBe(42);
    expect(rows[1].githubUserId).toBe(43);
    expect(rows[2].githubUserId).toBeNull();
    const indexes = await db().collection('githubinstallations').indexes();
    expect(indexes.some((index) => index.name === 'githubUserId_1')).toBe(true);

    // 幂等：重跑零变更
    await migration.run();
    const again = await db()
      .collection('githubinstallations')
      .find({}, { projection: { githubUserId: 1 } })
      .sort({ installationId: 1 })
      .toArray();
    expect(again).toEqual(rows.map((row) => ({ _id: row._id, githubUserId: row.githubUserId })));
  });
});
