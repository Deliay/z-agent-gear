import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { CloudHostSpec } from '../models/cloud-host-spec.js';
import { Tenant } from '../models/tenant.js';
import { CloudHostSpecService } from './cloud-host-spec.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './billing/testing/mongo.js';

const service = new CloudHostSpecService();

function input(overrides: Record<string, unknown> = {}) {
  return {
    name: '4C 8G 20G',
    cpu: 4,
    memoryGi: 8,
    ephemeralStorageGi: 20,
    whitelistEnabled: false,
    allowedTenantIds: [] as string[],
    ...overrides,
  };
}

async function tenant(name = 'team-a') {
  const doc = await Tenant.create({ name, type: 'team' });
  return String(doc._id);
}

describe('CloudHostSpecService（T-SPV 规格校验）', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  it('T-SPV1: 名称必填/长度/唯一', async () => {
    await expect(service.create(input({ name: '   ' }))).rejects.toThrow('name is required');
    await expect(service.create(input({ name: 'x'.repeat(65) }))).rejects.toThrow(
      'name is too long',
    );
    await service.create(input());
    await expect(service.create(input({ name: '4C 8G 20G' }))).rejects.toThrow(
      'spec name already exists',
    );
  });

  it('T-SPV2: 数值上限与整数校验', async () => {
    await expect(service.create(input({ cpu: 65 }))).rejects.toThrow('invalid spec resources');
    await expect(service.create(input({ memoryGi: 257 }))).rejects.toThrow(
      'invalid spec resources',
    );
    await expect(service.create(input({ ephemeralStorageGi: 513 }))).rejects.toThrow(
      'invalid spec resources',
    );
    await expect(service.create(input({ cpu: 1.5 }))).rejects.toThrow('invalid spec resources');
  });

  it('T-SPV3: 全零或全正（部分 0 拒绝）', async () => {
    await expect(
      service.create(input({ cpu: 0, memoryGi: 8, ephemeralStorageGi: 20 })),
    ).rejects.toThrow('invalid spec resources');
    await expect(
      service.create(input({ cpu: 4, memoryGi: 0, ephemeralStorageGi: 20 })),
    ).rejects.toThrow('invalid spec resources');
    const unlimited = await service.create(
      input({ name: '0C 0G 0G', cpu: 0, memoryGi: 0, ephemeralStorageGi: 0 }),
    );
    expect(unlimited.unlimited).toBe(true);
  });

  it('T-SPV4: whitelistEnabled=false 保存时置空名单', async () => {
    const tenantId = await tenant();
    const spec = await service.create(
      input({ whitelistEnabled: false, allowedTenantIds: [tenantId] }),
    );
    expect(spec.allowedTenantIds).toEqual([]);
  });

  it('T-SPV5: 白名单租户存在性校验', async () => {
    const missing = new mongoose.Types.ObjectId().toString();
    await expect(
      service.create(input({ whitelistEnabled: true, allowedTenantIds: [missing] })),
    ).rejects.toThrow('invalid tenant in whitelist');
    const tenantId = await tenant();
    const spec = await service.create(
      input({ whitelistEnabled: true, allowedTenantIds: [tenantId, tenantId] }),
    );
    expect(spec.allowedTenantIds).toEqual([tenantId]);
  });

  it('T-SPV6: 白名单上限 200', async () => {
    const ids = Array.from({ length: 201 }, (_, index) =>
      (index + 1000).toString(16).padStart(24, '0'),
    );
    await expect(
      service.create(input({ whitelistEnabled: true, allowedTenantIds: ids })),
    ).rejects.toThrow('invalid tenant in whitelist');
  });

  it('列表关键字搜索与分页', async () => {
    await service.create(input({ name: '8C 16G 20G' }));
    await service.create(input({ name: '4C 8G 20G' }));
    await service.create(input({ name: '2C 4G 10G' }));
    const filtered = await service.list({ keyword: '8c', page: 1, pageSize: 20 });
    expect(filtered.map((spec) => spec.name)).toEqual(['8C 16G 20G']);
    const byStorage = await service.list({ keyword: '20g', page: 1, pageSize: 20 });
    expect(byStorage.map((spec) => spec.name)).toEqual(['8C 16G 20G', '4C 8G 20G']);
    const first = await service.list({ page: 1, pageSize: 2 });
    const second = await service.list({ page: 2, pageSize: 2 });
    expect(first).toHaveLength(2);
    expect(first.map((spec) => spec.id)).not.toEqual(second.map((spec) => spec.id));
  });

  it('更新：改名冲突/不存在/删除', async () => {
    const first = await service.create(input({ name: 'A' }));
    const second = await service.create(input({ name: 'B' }));
    await expect(service.update(second.id, input({ name: 'A' }))).rejects.toThrow(
      'spec name already exists',
    );
    await expect(
      service.update(new mongoose.Types.ObjectId().toString(), input()),
    ).rejects.toThrow('spec not found');
    expect(await service.delete(first.id)).toBe(true);
    expect(await service.delete(first.id)).toBe(false);
    expect(await CloudHostSpec.countDocuments()).toBe(1);
  });
});
