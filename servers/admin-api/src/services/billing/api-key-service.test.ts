import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { apiKeyService } from './api-key-service.js';
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
});
