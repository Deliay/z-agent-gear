import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './028-workflow-interrupt.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-028-test'));
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const db = () => mongoose.connection.db!;
const instances = () => db().collection('workflowinstances');

beforeEach(async () => {
  await instances().drop().catch(() => undefined);
});

describe('migration 028 workflow interrupt', () => {
  it('T-MIG1: run() 幂等——重复调用不抛错、不改动数据', async () => {
    const id = new mongoose.Types.ObjectId();
    await instances().insertOne({
      _id: id,
      userId: new mongoose.Types.ObjectId(),
      name: '实例',
      nodes: [
        {
          nodeId: 'n1',
          nodeKey: 'n1',
          type: 'AI',
          name: '节点',
          stage: '阶段',
          status: 'RUNNING',
          dependsOn: [],
          reworkCount: 0,
          failInfo: { reason: 'r', source: 'MANUAL_INTERRUPT', at: new Date() },
        },
      ],
    });

    // 首次调用
    await expect(migration.run()).resolves.toBeUndefined();

    // 重复调用不抛错（幂等 no-op）
    await expect(migration.run()).resolves.toBeUndefined();
    await expect(migration.run()).resolves.toBeUndefined();

    // 数据无改动
    const row = await instances().findOne({ _id: id });
    expect(row?.name).toBe('实例');
    expect(row?.nodes[0].failInfo.source).toBe('MANUAL_INTERRUPT');
  });

  it('T-MIG1b: 空集合上 run() 幂等不抛错', async () => {
    await expect(migration.run()).resolves.toBeUndefined();
    await expect(migration.run()).resolves.toBeUndefined();
  });
});
