import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { logger as rootLogger } from '../observability/logger.js';
import { createTestLogger } from '../observability/testing.js';

/**
 * 注入 createTestLogger：在被测模块加载前拦截 `rootLogger.child(...)`，把迁移日志写入内存
 * sink，断言 `records` 的结构化字段（`msg`/`component`/`tenantId` 等），不拼接字符串。
 */
const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const migration = await import('./002-cloudcontainers-workspace-id.js');
childSpy.mockRestore();

/**
 * 真库用例（T-MIG002a~c）：workspaceId 回填 / 幂等重跑 / 解析不到跳过，口径与 001 同款。
 *
 * `workspaces` 由 agent-api 管理（`tenantId` 为 ObjectId），`cloudcontainers.tenantId` 为 String
 * （多租户一期 F8）——解析必须同时兼容两种存储形态。
 */
describe('migration 002 cloudcontainers workspaceId (real db)', () => {
  let server: MongoMemoryServer;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri('agent-gear-cloud-controller-test-002'));
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });

  beforeEach(async () => {
    testLog.reset();
    await collection().deleteMany({});
    await workspaces().deleteMany({});
  });

  const collection = () => mongoose.connection.collection('cloudcontainers');
  const workspaces = () => mongoose.connection.collection('workspaces');

  it('T-MIG002a: 按 tenantId 回填 global 工作区（兼容 workspaces.tenantId 的 ObjectId / String 口径）', async () => {
    const tenantA = new mongoose.Types.ObjectId();
    const tenantB = new mongoose.Types.ObjectId();
    const globalA = new mongoose.Types.ObjectId();
    const globalB = new mongoose.Types.ObjectId();
    const normalA = new mongoose.Types.ObjectId();

    await workspaces().insertMany([
      // agent-api 实际口径：tenantId 为 ObjectId
      { _id: globalA, tenantId: tenantA, name: '全局工作区', type: 'global' },
      { _id: normalA, tenantId: tenantA, name: '项目组', type: 'normal' },
      // 兼容口径：tenantId 为 String
      { _id: globalB, tenantId: tenantB.toHexString(), name: '全局工作区', type: 'global' },
    ]);

    await collection().insertMany([
      { name: 'c-a', userId: 'u-a', tenantId: tenantA.toHexString(), purpose: 'harness' },
      { name: 'c-b', userId: 'u-b', tenantId: tenantB.toHexString(), purpose: 'harness' },
      // 已有 workspaceId 的行不得改动
      {
        name: 'c-keep',
        userId: 'u-k',
        tenantId: tenantA.toHexString(),
        workspaceId: 'explicit-ws',
        purpose: 'harness',
      },
    ]);

    await migration.run();

    const rows = await collection().find({}).toArray();
    const byName = (name: string) => rows.find((row) => row.name === name);
    // 只解析 type='global'（normal 工作区不参与回退），且只匹配本租户
    expect(byName('c-a')?.workspaceId).toBe(globalA.toHexString());
    expect(byName('c-b')?.workspaceId).toBe(globalB.toHexString());
    expect(byName('c-keep')?.workspaceId).toBe('explicit-ws');
  });

  it('T-MIG002b: 幂等重跑（二次 run 数据零变更）且创建 { workspaceId: 1 } 索引', async () => {
    const tenantA = new mongoose.Types.ObjectId();
    const globalA = new mongoose.Types.ObjectId();
    await workspaces().insertOne({
      _id: globalA,
      tenantId: tenantA,
      name: '全局工作区',
      type: 'global',
    });
    await collection().insertOne({
      name: 'c-1',
      userId: 'u-1',
      tenantId: tenantA.toHexString(),
      purpose: 'harness',
    });

    await migration.run();
    const afterFirst = await collection().find({}).sort({ _id: 1 }).toArray();

    await migration.run();
    const afterSecond = await collection().find({}).sort({ _id: 1 }).toArray();

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond[0]?.workspaceId).toBe(globalA.toHexString());

    const indexes = await collection().indexes();
    expect(indexes.some((index) => index.key && index.key.workspaceId === 1)).toBe(true);
  });

  it('T-MIG002c: 解析不到 global 工作区 → workspaceId 置 null；tenantId 缺失的行跳过', async () => {
    await collection().insertMany([
      // 租户存在但没有 global 工作区（半完成开户）
      { name: 'c-no-global', userId: 'u-2', tenantId: 'tenant-without-global', purpose: 'harness' },
      // 同库完全没有该租户
      { name: 'c-no-tenant', userId: 'u-3', tenantId: 'tenant-absent', purpose: 'harness' },
      // 无租户归属的存量行（如 idle 容器）：与 001 同口径跳过、不改动
      { name: 'c-no-tenant-id', purpose: 'idle' },
    ]);

    await migration.run();

    const rows = await collection().find({}).toArray();
    const byName = (name: string) => rows.find((row) => row.name === name);
    expect(byName('c-no-global')?.workspaceId ?? null).toBeNull();
    expect(byName('c-no-tenant')?.workspaceId ?? null).toBeNull();
    expect(byName('c-no-tenant-id')).not.toHaveProperty('workspaceId');
    // 断言 warn 的结构化记录（msg 含固定短语 + tenantId 进字段）
    expect(testLog.records).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        component: 'migration/002',
        msg: expect.stringContaining('无法解析全局工作区'),
        tenantId: 'tenant-without-global',
      }),
    );
    expect(testLog.records).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        component: 'migration/002',
        msg: expect.stringContaining('无法解析全局工作区'),
        tenantId: 'tenant-absent',
      }),
    );
  });
});
