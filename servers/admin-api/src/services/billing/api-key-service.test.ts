import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { apiKeyService, ApiKeyNotFoundError } from './api-key-service.js';
import { BillingApiKey } from '../../models/billing-api-key.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

describe('ApiKeyService', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  it('T-A3: 生成返回一次性完整 secret，列表只含前缀，校验成功更新 lastUsedAt', async () => {
    const accountId = new mongoose.Types.ObjectId().toString();
    const ownerId = new mongoose.Types.ObjectId().toString();
    const { apiKey, secret } = await apiKeyService.create({
      accountId,
      ownerType: 'front_user',
      ownerId,
      name: 'my-key',
    });
    expect(secret).toMatch(/^zag_sk_[0-9a-f]{32}$/);
    expect(secret.startsWith(apiKey.keyPrefix)).toBe(true);
    expect(apiKey.status).toBe('active');

    const verified = await apiKeyService.verify(secret);
    expect(verified?.id).toBe(apiKey.id);
    expect(verified?.accountId).toBe(accountId);

    const list = await apiKeyService.list('front_user', ownerId);
    expect(list).toHaveLength(1);
    expect(list[0].keyPrefix).toBe(apiKey.keyPrefix);
    expect((list[0] as unknown as { secret?: string }).secret).toBeUndefined();
    expect((await apiKeyService.list('front_user', ownerId))[0].lastUsedAt).not.toBeNull();
  });

  it('T-A4: 吊销后立即失效；非本人不可吊销', async () => {
    const accountId = new mongoose.Types.ObjectId().toString();
    const ownerId = new mongoose.Types.ObjectId().toString();
    const { apiKey, secret } = await apiKeyService.create({
      accountId,
      ownerType: 'front_user',
      ownerId,
      name: 'k',
    });
    await expect(
      apiKeyService.revoke(apiKey.id, {
        ownerType: 'front_user',
        ownerId: new mongoose.Types.ObjectId().toString(),
      }),
    ).rejects.toThrow();

    const revoked = await apiKeyService.revoke(apiKey.id, { ownerType: 'front_user', ownerId });
    expect(revoked.status).toBe('revoked');
    expect(await apiKeyService.verify(secret)).toBeNull();
  });

  it('非法/未知 Key 返回 null，空名称拒绝', async () => {
    expect(await apiKeyService.verify('not-a-key')).toBeNull();
    expect(await apiKeyService.verify('zag_sk_ffffffffffffffffffffffffffffffff')).toBeNull();
    await expect(
      apiKeyService.create({
        accountId: new mongoose.Types.ObjectId().toString(),
        ownerType: 'front_user',
        ownerId: 'u1',
        name: '   ',
      }),
    ).rejects.toThrow();
  });

  // ===== Phase 2：scope=cloud_host 运行专用 Key =====

  it('T-BK1: 账号 Key 回归 — scope=account、cloudHostId/expiresAt 为 null', async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    const { apiKey, secret } = await apiKeyService.create({
      accountId: new mongoose.Types.ObjectId().toString(),
      ownerType: 'front_user',
      ownerId,
      name: 'account-key',
    });
    expect(apiKey.scope).toBe('account');
    expect(apiKey.cloudHostId).toBeNull();
    expect(apiKey.expiresAt).toBeNull();

    const verified = await apiKeyService.verify(secret);
    expect(verified).toMatchObject({
      id: apiKey.id,
      scope: 'account',
      cloudHostId: null,
      expiresAt: null,
    });

    const list = await apiKeyService.list('front_user', ownerId);
    expect(list).toHaveLength(1);
    expect(list[0].scope).toBe('account');
  });

  it('T-BK2: createCloudHostScopedKey 落库 scope/cloudHostId/expiresAt，明文仅一次且不落库', async () => {
    const accountId = new mongoose.Types.ObjectId().toString();
    const ownerId = new mongoose.Types.ObjectId().toString();
    const cloudHostId = new mongoose.Types.ObjectId().toString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const { apiKey, secret } = await apiKeyService.createCloudHostScopedKey({
      accountId,
      ownerType: 'front_user',
      ownerId,
      name: 'host-key',
      cloudHostId,
      expiresAt,
    });

    expect(apiKey.scope).toBe('cloud_host');
    expect(apiKey.cloudHostId).toBe(cloudHostId);
    expect(apiKey.expiresAt?.getTime()).toBe(expiresAt.getTime());

    const verified = await apiKeyService.verify(secret);
    expect(verified).toMatchObject({ id: apiKey.id, scope: 'cloud_host', cloudHostId });
    expect(verified?.expiresAt?.getTime()).toBe(expiresAt.getTime());

    const list = await apiKeyService.list('front_user', ownerId);
    expect(list).toHaveLength(1);
    expect((list[0] as unknown as { secret?: string }).secret).toBeUndefined();
  });

  it('T-BK16: Key 明文不落库（库内仅前缀 + 哈希）', async () => {
    const cloudHostId = new mongoose.Types.ObjectId().toString();
    const { secret } = await apiKeyService.createCloudHostScopedKey({
      accountId: new mongoose.Types.ObjectId().toString(),
      ownerType: 'front_user',
      ownerId: 'u-secret',
      name: 'host-key',
      cloudHostId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const raw = await mongoose.connection.db!
      .collection('billingapikeys')
      .find({})
      .toArray();
    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw)).not.toContain(secret);
    expect(String(raw[0].keyHash)).not.toBe(secret);
    expect(String(raw[0].keyPrefix)).toBe(secret.slice(0, 16));
  });

  it('T-BK3: 同宿主重复铸造 — 旧 active Key 被撤销，旧明文失效', async () => {
    const accountId = new mongoose.Types.ObjectId().toString();
    const cloudHostId = new mongoose.Types.ObjectId().toString();
    const first = await apiKeyService.createCloudHostScopedKey({
      accountId,
      ownerType: 'front_user',
      ownerId: 'u-rotate',
      name: 'host-key-1',
      cloudHostId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const second = await apiKeyService.createCloudHostScopedKey({
      accountId,
      ownerType: 'front_user',
      ownerId: 'u-rotate',
      name: 'host-key-2',
      cloudHostId,
      expiresAt: new Date(Date.now() + 120_000),
    });

    expect(await apiKeyService.verify(first.secret)).toBeNull();
    expect((await apiKeyService.verify(second.secret))?.id).toBe(second.apiKey.id);

    const active = await BillingApiKey.find({ cloudHostId, status: 'active' }).lean();
    expect(active).toHaveLength(1);
    expect(String(active[0]._id)).toBe(second.apiKey.id);
  });

  it('T-BK4: verify 对过期 Key 返回 null', async () => {
    const { secret } = await apiKeyService.createCloudHostScopedKey({
      accountId: new mongoose.Types.ObjectId().toString(),
      ownerType: 'front_user',
      ownerId: 'u-expired',
      name: 'expired-key',
      cloudHostId: new mongoose.Types.ObjectId().toString(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { BillingApiKey } = await import('../../models/billing-api-key.js');
    await BillingApiKey.updateMany(
      { scope: 'cloud_host', ownerId: 'u-expired' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect(await apiKeyService.verify(secret)).toBeNull();
  });

  it('T-BK6: revokeById 幂等、未知 id 报 ApiKeyNotFoundError、不要求 owner', async () => {
    const { apiKey } = await apiKeyService.createCloudHostScopedKey({
      accountId: new mongoose.Types.ObjectId().toString(),
      ownerType: 'front_user',
      ownerId: 'u-revoke',
      name: 'k',
      cloudHostId: new mongoose.Types.ObjectId().toString(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const first = await apiKeyService.revokeById(apiKey.id);
    expect(first.status).toBe('revoked');
    // 幂等：重复撤销仍返回同一 Key
    const second = await apiKeyService.revokeById(apiKey.id);
    expect(second.id).toBe(apiKey.id);
    expect(second.status).toBe('revoked');

    await expect(
      apiKeyService.revokeById(new mongoose.Types.ObjectId().toString()),
    ).rejects.toBeInstanceOf(ApiKeyNotFoundError);
    await expect(apiKeyService.revokeById('not-an-object-id')).rejects.toBeInstanceOf(
      ApiKeyNotFoundError,
    );
  });

  it('T-BK7: revokeByCloudHost 撤销同宿主全部 active，重复调用幂等', async () => {
    const accountId = new mongoose.Types.ObjectId().toString();
    const cloudHostId = new mongoose.Types.ObjectId().toString();
    const otherHostId = new mongoose.Types.ObjectId().toString();
    // 直接落库模拟历史遗留的同宿主多枚 active Key（轮换前数据）
    await BillingApiKey.create([
      {
        accountId,
        ownerType: 'front_user',
        ownerId: 'u-host',
        name: 'a',
        keyPrefix: 'zag_sk_aaaaaaaa',
        keyHash: 'h1',
        scope: 'cloud_host',
        cloudHostId,
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        accountId,
        ownerType: 'front_user',
        ownerId: 'u-host',
        name: 'b',
        keyPrefix: 'zag_sk_bbbbbbbb',
        keyHash: 'h2',
        scope: 'cloud_host',
        cloudHostId,
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        accountId,
        ownerType: 'front_user',
        ownerId: 'u-host',
        name: 'c',
        keyPrefix: 'zag_sk_cccccccc',
        keyHash: 'h3',
        scope: 'cloud_host',
        cloudHostId: otherHostId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    expect(await apiKeyService.revokeByCloudHost(cloudHostId)).toBe(2);
    expect(await BillingApiKey.countDocuments({ cloudHostId, status: 'active' })).toBe(0);
    expect(await BillingApiKey.countDocuments({ cloudHostId: otherHostId, status: 'active' })).toBe(1);
    // 幂等
    expect(await apiKeyService.revokeByCloudHost(cloudHostId)).toBe(0);
  });

  it('T-BK2/U: cloud_host 必填 cloudHostId 与合法有效期', async () => {
    await expect(
      apiKeyService.createCloudHostScopedKey({
        accountId: new mongoose.Types.ObjectId().toString(),
        ownerType: 'front_user',
        ownerId: 'u',
        name: 'k',
        cloudHostId: 'not-an-object-id',
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow();
    await expect(
      apiKeyService.createCloudHostScopedKey({
        accountId: new mongoose.Types.ObjectId().toString(),
        ownerType: 'front_user',
        ownerId: 'u',
        name: 'k',
        cloudHostId: new mongoose.Types.ObjectId().toString(),
        expiresAt: new Date('invalid'),
      }),
    ).rejects.toThrow();
  });
});
