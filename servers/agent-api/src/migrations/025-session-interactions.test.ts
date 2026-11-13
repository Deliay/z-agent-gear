import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './025-session-interactions.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-025-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const db = () => mongoose.connection.db!;
const interactions = () => db().collection('sessioninteractions');

beforeEach(async () => {
  await interactions().drop().catch(() => undefined);
});

describe('migration 025 session interactions', () => {
  it('T-MIG25-1: 创建 interactionId 唯一 + 会话时间线 + pending 聚合 + elicitationId sparse 索引', async () => {
    await migration.createSessionInteractionIndexes();
    const indexes = await interactions().indexes();
    const byName = new Map(indexes.map((index) => [index.name, index]));

    expect(byName.get('uniq_session_interaction_id')).toMatchObject({
      key: { interactionId: 1 },
      unique: true,
    });
    expect(byName.get('session_interaction_session_created')).toMatchObject({
      key: { sessionId: 1, createdAt: 1 },
    });
    expect(byName.get('session_interaction_session_status_expires')).toMatchObject({
      key: { sessionId: 1, status: 1, expiresAt: 1 },
    });
    expect(byName.get('session_interaction_elicitation')).toMatchObject({
      key: { elicitationId: 1 },
      sparse: true,
    });
  });

  it('T-MIG25-2: interactionId 唯一索引生效（重复插入抛 E11000）', async () => {
    await migration.createSessionInteractionIndexes();
    await interactions().insertOne({ interactionId: 'req-1' });
    await expect(interactions().insertOne({ interactionId: 'req-1' })).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('T-MIG25-3: 迁移重跑幂等（不报错、索引数量与定义不变）+ 名称接续 024', async () => {
    await migration.run();
    const first = (await interactions().indexes()).map((index) => index.name).sort();

    await expect(migration.run()).resolves.toBeUndefined();
    const second = (await interactions().indexes()).map((index) => index.name).sort();

    expect(second).toEqual(first);
    expect(first).toHaveLength(5); // _id_ + 4
    expect(migration.name).toBe('025-session-interactions');
  });
});
