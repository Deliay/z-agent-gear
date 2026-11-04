import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './021-workflow-interrupt-retry.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-021-test'));
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

function instanceDoc(nodes: Record<string, unknown>[]) {
  return {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    nodes: nodes.map((node) => ({
      nodeId: new mongoose.Types.ObjectId().toString(),
      nodeKey: 'n',
      type: 'AI',
      name: '节点',
      stage: '阶段',
      status: 'RUNNING',
      ...node,
    })),
  };
}

describe('migration 021 workflow interrupt retry', () => {
  it('T-MIG1: fallbackSent=true → retryCount=1 且 fallbackSent 已删除', async () => {
    const id = new mongoose.Types.ObjectId();
    await instances().insertOne({
      ...instanceDoc([{ fallbackSent: true }]),
      _id: id,
    });

    await migration.run();

    const row = await instances().findOne({ _id: id });
    expect(row?.nodes[0].retryCount).toBe(1);
    expect(row?.nodes[0]).not.toHaveProperty('fallbackSent');
  });

  it('T-MIG2: 无 fallbackSent 的节点补 retryCount=0（含未设置与 false 两种）', async () => {
    const id = new mongoose.Types.ObjectId();
    await instances().insertOne({
      ...instanceDoc([{ fallbackSent: false }, {}]),
      _id: id,
    });

    await migration.run();

    const row = await instances().findOne({ _id: id });
    expect(row?.nodes[0].retryCount).toBe(0);
    expect(row?.nodes[1].retryCount).toBe(0);
    expect(row?.nodes[0]).not.toHaveProperty('fallbackSent');
    expect(row?.nodes[1]).not.toHaveProperty('fallbackSent');
  });

  it('T-MIG3: nodes.nextRetryAt 部分索引存在且重跑幂等', async () => {
    await instances().insertOne(instanceDoc([{ fallbackSent: true }, {}]));

    await migration.run();
    const first = await instances().indexes();
    const index = first.find((item) => item.name === migration.WORKFLOW_INTERRUPT_RETRY_INDEX_NAME);
    expect(index).toMatchObject({
      key: { 'nodes.nextRetryAt': 1 },
      partialFilterExpression: { 'nodes.nextRetryAt': { $exists: true } },
    });

    await expect(migration.run()).resolves.toBeUndefined();
    const second = await instances().indexes();
    expect(second.map((item) => item.name).sort()).toEqual(first.map((item) => item.name).sort());

    const row = await instances().findOne({});
    expect(row?.nodes[0].retryCount).toBe(1);
    expect(row?.nodes[1].retryCount).toBe(0);
  });
});
