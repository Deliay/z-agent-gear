import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './026-custom-tools.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-026-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const db = () => mongoose.connection.db!;
const tools = () => db().collection('customtools');

beforeEach(async () => {
  await tools().drop().catch(() => undefined);
});

describe('migration 026 custom tools', () => {
  it('T-MIG26：创建 uniq_custom_tool_workspace_name 唯一索引 + tenantId 索引', async () => {
    await migration.createCustomToolIndexes();
    const byName = new Map((await tools().indexes()).map((index) => [index.name, index]));

    expect(byName.get('uniq_custom_tool_workspace_name')).toMatchObject({
      key: { workspaceId: 1, name: 1 },
      unique: true,
    });
    expect(byName.get('custom_tool_tenant')).toMatchObject({ key: { tenantId: 1 } });
  });

  it('T-MIG26：唯一索引生效（同工作区重名 E11000，跨工作区允许）', async () => {
    await migration.createCustomToolIndexes();
    const wsA = new mongoose.Types.ObjectId();
    const wsB = new mongoose.Types.ObjectId();
    await tools().insertOne({ workspaceId: wsA, name: 't1' });
    await expect(tools().insertOne({ workspaceId: wsA, name: 't1' })).rejects.toMatchObject({
      code: 11000,
    });
    await expect(tools().insertOne({ workspaceId: wsB, name: 't1' })).resolves.toBeTruthy();
  });

  it('T-MIG26：二次 run 幂等零变更', async () => {
    await migration.run();
    const first = (await tools().indexes()).map((index) => index.name).sort();
    await migration.run();
    const second = (await tools().indexes()).map((index) => index.name).sort();
    expect(second).toEqual(first);
  });
});
