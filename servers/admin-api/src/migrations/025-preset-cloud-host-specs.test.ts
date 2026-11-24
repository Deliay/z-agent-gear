import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { CloudHostSpec } from '../models/cloud-host-spec.js';
import { CloudBillingCursor } from '../models/cloud-billing-cursor.js';
import { PRESET_CLOUD_HOST_SPECS, run } from './025-preset-cloud-host-specs.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../services/billing/testing/mongo.js';

describe('migration 025-preset-cloud-host-specs（T-MIG-SP）', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  it('T-MIG-SP1: 播种 6 款预制规格（按 presetKey/name 双查）', async () => {
    await run();
    const specs = await CloudHostSpec.find().sort({ cpu: -1 }).lean();
    expect(specs).toHaveLength(6);
    expect(specs.map((spec) => spec.name)).toEqual([
      '8C 16G 20G',
      '8C 8G 20G',
      '4C 8G 20G',
      '2C 4G 10G',
      '1C 2G 5G',
      '0C 0G 0G',
    ]);
    for (const spec of specs) {
      expect(spec.isPreset).toBe(true);
      expect(PRESET_CLOUD_HOST_SPECS.some((preset) => preset.presetKey === spec.presetKey)).toBe(
        true,
      );
    }
  });

  it('T-MIG-SP2: 0C 0G 默认开启白名单且空名单（无租户可见）', async () => {
    await run();
    const unlimited = await CloudHostSpec.findOne({ presetKey: 'unlimited-0c0g' }).lean();
    expect(unlimited?.cpu).toBe(0);
    expect(unlimited?.memoryGi).toBe(0);
    expect(unlimited?.ephemeralStorageGi).toBe(0);
    expect(unlimited?.whitelistEnabled).toBe(true);
    expect(unlimited?.allowedTenantIds).toEqual([]);
    const others = await CloudHostSpec.find({ presetKey: { $ne: 'unlimited-0c0g' } }).lean();
    expect(others.every((spec) => spec.whitelistEnabled === false)).toBe(true);
  });

  it('T-MIG-SP3: 幂等重跑零变更（不覆盖管理员修改；删除不重建由迁移账本保证）', async () => {
    await run();
    await CloudHostSpec.updateOne({ presetKey: '4c8g-20g' }, { $set: { name: '4C 8G 20G 定制' } });

    // 迁移 runner 按 name 去重（admin_migrations 账本），生产环境只会执行一次；
    // 这里直接重跑 run() 验证「已存在即跳过、不覆盖管理员修改」。
    await run();
    expect(await CloudHostSpec.countDocuments()).toBe(6);
    expect((await CloudHostSpec.findOne({ presetKey: '4c8g-20g' }).lean())?.name).toBe(
      '4C 8G 20G 定制',
    );

    const before = await CloudHostSpec.find().sort({ presetKey: 1 }).lean();
    await run();
    const after = await CloudHostSpec.find().sort({ presetKey: 1 }).lean();
    expect(after).toEqual(before);
  });

  it('T-MIG-SP4: 显式创建 cloudbillingcursors 索引（幂等）', async () => {
    await run();
    const indexes = await CloudBillingCursor.collection.indexes();
    expect(indexes.some((index) => index.key.resourceId === 1 && index.unique === true)).toBe(
      true,
    );
    expect(
      indexes.some(
        (index) => index.key.closedAt === 1 && index.key.lastChargedAt === 1,
      ),
    ).toBe(true);
  });
});
