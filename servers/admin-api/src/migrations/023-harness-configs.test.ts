import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { logger as rootLogger } from '../observability/logger.js';
import { createTestLogger } from '../observability/testing.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../services/billing/testing/mongo.js';
import { HARNESS_CONFIG_TYPES } from '../models/harness-config.js';

/**
 * 注入 createTestLogger：在被测模块加载前拦截 `logger.child(...)`，迁移日志写入内存 sink，
 * 断言结构化字段（`component` 必须为 `migration/023-harness-configs`，见 contracts/observability.md）。
 */
const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const migration = await import('./023-harness-configs.js');
childSpy.mockRestore();

function configs() {
  return mongoose.connection.db!.collection('harnessconfigs');
}

async function rows() {
  return configs().find({}).toArray();
}

describe('migration 023-harness-configs', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);

  afterAll(async () => {
    await disconnectTestDb();
  });

  beforeEach(async () => {
    testLog.reset();
    await clearTestDb();
    // 隔离本迁移的建索引行为：清掉 syncIndexes 预先建好的索引（_id 索引保留）
    await configs()
      .dropIndexes()
      .catch(() => undefined);
  });

  it('exposes the migration name', () => {
    expect(migration.name).toBe('023-harness-configs');
  });

  it('T-MIG-HC1: 执行后三 Harness 各一条 /compact，重复执行幂等', async () => {
    await migration.run();

    const first = await rows();
    expect(first).toHaveLength(3);
    expect(first.map((row) => row.harnessType).sort()).toEqual([...HARNESS_CONFIG_TYPES].sort());
    for (const row of first) {
      expect(row.compactCommand).toBe('/compact');
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    }

    // 重复执行：不新增行、不改变 updatedAt（$setOnInsert 仅在插入路径生效）
    await migration.run();
    const second = await rows();
    expect(second).toHaveLength(3);
    expect(second.map((row) => row.harnessType).sort()).toEqual([...HARNESS_CONFIG_TYPES].sort());
    for (const row of second) {
      const before = first.find((entry) => entry.harnessType === row.harnessType)!;
      expect(new Date(row.updatedAt as Date).getTime()).toBe(
        new Date(before.updatedAt as Date).getTime(),
      );
    }
  });

  it('T-MIG-HC2: 用户已改为 /custom 后重跑不覆盖；唯一索引 uniq_harness_config_type 存在', async () => {
    await migration.run();
    await configs().updateOne(
      { harnessType: 'KIMI_CODE' },
      { $set: { compactCommand: '/custom' } },
    );

    await migration.run();

    const kimi = await configs().findOne({ harnessType: 'KIMI_CODE' });
    expect(kimi?.compactCommand).toBe('/custom');
    expect(await configs().countDocuments()).toBe(3);
    const others = await configs()
      .find({ harnessType: { $ne: 'KIMI_CODE' } })
      .toArray();
    for (const row of others) expect(row.compactCommand).toBe('/compact');

    const indexes = await configs().indexes();
    const unique = indexes.find((index) => index.name === 'uniq_harness_config_type');
    expect(unique).toMatchObject({ unique: true, key: { harnessType: 1 } });
  });

  it('日志走结构化 logger（component 固定，无 console）', async () => {
    await migration.run();
    const record = testLog.records.find((entry) => entry.msg === 'migration completed');
    expect(record).toBeTruthy();
    expect(record?.component).toBe('migration/023-harness-configs');
    expect(record?.harnessTypes).toEqual([...HARNESS_CONFIG_TYPES]);
    expect(record?.indexes).toContain('uniq_harness_config_type');
    expect(record?.documentCount).toBe(3);
  });
});
