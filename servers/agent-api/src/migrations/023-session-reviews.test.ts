import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './023-session-reviews.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-023-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const db = () => mongoose.connection.db!;
const reviews = () => db().collection('sessionreviews');

beforeEach(async () => {
  await reviews().drop().catch(() => undefined);
});

describe('migration 023 session reviews', () => {
  it('T-MIG-SR1: 创建 {userId,status,createdAt} 与 {sessionId,status} 两索引', async () => {
    await migration.createSessionReviewIndexes();
    const indexes = await reviews().indexes();
    const byName = new Map(indexes.map((index) => [index.name, index]));

    expect(byName.get('session_review_user_status_created')).toMatchObject({
      key: { userId: 1, status: 1, createdAt: -1 },
    });
    expect(byName.get('session_review_session_status')).toMatchObject({
      key: { sessionId: 1, status: 1 },
    });
  });

  it('T-MIG-SR2: 迁移重跑幂等（不报错、索引数量与定义不变）', async () => {
    await migration.run();
    const first = (await reviews().indexes()).map((index) => index.name).sort();

    await expect(migration.run()).resolves.toBeUndefined();
    const second = (await reviews().indexes()).map((index) => index.name).sort();

    expect(second).toEqual(first);
    expect(first).toHaveLength(3); // _id_ + 2
  });

  it('T-MIG-SR3: 名称 023-session-reviews（接续 022）', () => {
    expect(migration.name).toBe('023-session-reviews');
  });
});
