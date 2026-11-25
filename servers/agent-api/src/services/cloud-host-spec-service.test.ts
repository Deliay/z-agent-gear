import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const billingMock = vi.hoisted(() => ({
  getSpecQuote: vi.fn(),
  getAccount: vi.fn(),
}));

vi.mock('./billing-client.js', () => ({
  billingClient: billingMock,
  BillingServiceUnavailableError: class extends Error {},
  InsufficientBalanceError: class extends Error {},
}));

import { CloudHostSpec } from '../models/cloud-host-spec.js';
import {
  buildCloudHostSpecSnapshot,
  CloudHostSpecService,
  fallbackSpecHourlyCredits,
} from './cloud-host-spec-service.js';
import { runWithWorkspace, type WorkspaceContext } from './workspace-context.js';

let server: MongoMemoryServer;

const TENANT_A = '507f1f77bcf86cd7994390e1';
const TENANT_B = '507f1f77bcf86cd7994390e2';

const context: WorkspaceContext = {
  id: '507f1f77bcf86cd7994390f1',
  tenantId: TENANT_A,
  type: 'normal',
  role: 'developer',
  readOnly: false,
  globalWorkspaceId: '507f1f77bcf86cd7994390f2',
};

function withContext<T>(fn: () => Promise<T>): Promise<T> {
  return runWithWorkspace(context, fn);
}

async function createSpec(overrides: Record<string, unknown> = {}) {
  return CloudHostSpec.create({
    name: 'spec',
    cpu: 4,
    memoryGi: 8,
    ephemeralStorageGi: 20,
    whitelistEnabled: false,
    allowedTenantIds: [],
    ...overrides,
  });
}

describe('CloudHostSpecService（T-SPVIS 可见性 / T-CHS 快照）', () => {
  const service = new CloudHostSpecService();

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri('agent-api-cloud-host-spec-test'));
  }, 60000);
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });
  beforeEach(async () => {
    const collections = await mongoose.connection.db!.collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
    billingMock.getSpecQuote.mockResolvedValue({ hourlyCredits: 820, tiers: [] });
    billingMock.getAccount.mockResolvedValue({ availableBalance: 1000 });
  });

  it('T-SPVIS1: 公开规格对全部租户可见，按资源降序', async () => {
    await createSpec({ name: 'small', cpu: 2, memoryGi: 4, ephemeralStorageGi: 10 });
    await createSpec({ name: 'big', cpu: 8, memoryGi: 16, ephemeralStorageGi: 20 });
    const list = await withContext(() => service.listVisible());
    expect(list.map((item) => item.name)).toEqual(['big', 'small']);
    expect(list[0]?.hourlyCredits).toBe(820);
    expect(list[0]?.unlimited).toBe(false);
  });

  it('T-SPVIS2: 白名单命中可见（String id 归一）', async () => {
    await createSpec({
      name: 'team-only',
      whitelistEnabled: true,
      allowedTenantIds: [TENANT_A],
    });
    const list = await withContext(() => service.listVisible());
    expect(list.map((item) => item.name)).toEqual(['team-only']);
  });

  it('T-SPVIS3: 空名单（开启白名单）= 无租户可见；0C 0G 默认不可见', async () => {
    await createSpec({
      name: '0C 0G 0G',
      cpu: 0,
      memoryGi: 0,
      ephemeralStorageGi: 0,
      whitelistEnabled: true,
      allowedTenantIds: [],
    });
    expect(await withContext(() => service.listVisible())).toEqual([]);
    const spec = await CloudHostSpec.findOne({});
    expect(
      await withContext(() => service.findVisibleById(String(spec?._id ?? ''))),
    ).toBeNull();
  });

  it('T-SPVIS4: 移出名单后不可见；其他租户不可见', async () => {
    const spec = await createSpec({
      whitelistEnabled: true,
      allowedTenantIds: [TENANT_A],
    });
    expect(await withContext(() => service.findVisibleById(String(spec._id)))).not.toBeNull();
    await CloudHostSpec.updateOne({ _id: spec._id }, { $set: { allowedTenantIds: [TENANT_B] } });
    expect(await withContext(() => service.findVisibleById(String(spec._id)))).toBeNull();
  });

  it('T-SPVIS5: 无租户上下文不返回任何白名单规格（安全默认）', async () => {
    await createSpec({ whitelistEnabled: true, allowedTenantIds: [TENANT_A] });
    expect(await service.listVisible()).toEqual([]);
    expect(await withContext(() => service.findVisibleById('not-an-object-id'))).toBeNull();
  });

  it('计费不可用时列表降级本地默认价（D3）并保持 820', async () => {
    await createSpec({ name: '8C 16G 20G', cpu: 8, memoryGi: 16, ephemeralStorageGi: 20 });
    billingMock.getSpecQuote.mockRejectedValue(new Error('billing down'));
    const list = await withContext(() => service.listVisible());
    expect(list[0]?.hourlyCredits).toBe(820);
    expect(fallbackSpecHourlyCredits({ cpu: 8, memoryGi: 16, ephemeralStorageGi: 20 })).toBe(820);
  });

  it('quoteById：不可见/不存在报 spec not found；可见返回报价与余额', async () => {
    const spec = await createSpec({ whitelistEnabled: true, allowedTenantIds: [TENANT_A] });
    const quote = await withContext(() => service.quoteById(String(spec._id)));
    expect(quote.hourlyCredits).toBe(820);
    expect(quote.availableBalance).toBe(1000);
    await expect(
      withContext(() => service.quoteById(new mongoose.Types.ObjectId().toString())),
    ).rejects.toThrow('spec not found');
  });

  it('CloudHost.spec 快照装配不回查规格表（规格删除后仍可展示）', () => {
    const snapshot = buildCloudHostSpecSnapshot({
      specId: 'spec-1',
      specName: '8C 16G 20G',
      specCpu: 8,
      specMemoryGi: 16,
      specEphemeralStorageGi: 20,
    });
    expect(snapshot).toMatchObject({ id: 'spec-1', name: '8C 16G 20G', unlimited: false });
    expect(
      buildCloudHostSpecSnapshot({
        specId: 'spec-0',
        specName: '0C 0G 0G',
        specCpu: 0,
        specMemoryGi: 0,
        specEphemeralStorageGi: 0,
      })?.unlimited,
    ).toBe(true);
    expect(buildCloudHostSpecSnapshot({ specCpu: null })).toBeNull();
  });
});
