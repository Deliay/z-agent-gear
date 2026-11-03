import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { billingKeyAuth, type BillingRequest } from './billing-key-auth.js';
import { apiKeyService } from '../services/billing/api-key-service.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../services/billing/testing/mongo.js';

let app: Server;
let baseUrl = '';

function startGateway(): Promise<void> {
  return new Promise((resolve) => {
    const server = express();
    server.get('/probe', billingKeyAuth, (req, res) => {
      res.json({ billing: (req as BillingRequest).billing ?? null });
    });
    app = server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

/** 只读模型口径：cloudhosts 由 agent-api 写入，测试用原生集合插入避免依赖写模型。 */
async function seedCloudHost(input: {
  status?: string;
  deletedAt?: Date | null;
  userId?: string;
  tenantId?: string;
} = {}): Promise<string> {
  const _id = new mongoose.Types.ObjectId();
  await mongoose.connection.db!.collection('cloudhosts').insertOne({
    _id,
    userId: input.userId ?? 'probe-user',
    tenantId: input.tenantId ?? null,
    controllerId: new mongoose.Types.ObjectId(),
    status: input.status ?? 'RUNNING',
    deletedAt: input.deletedAt ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return _id.toString();
}

async function seedKey(input: {
  scope: 'account' | 'cloud_host';
  cloudHostId?: string;
  ownerType?: 'front_user' | 'tenant' | 'admin_user';
  ownerId?: string;
}): Promise<string> {
  const accountId = new mongoose.Types.ObjectId().toString();
  const ownerType = input.ownerType ?? 'front_user';
  const ownerId = input.ownerId ?? 'probe-user';
  if (input.scope === 'account') {
    const { secret } = await apiKeyService.create({
      accountId,
      ownerType,
      ownerId,
      name: 'account-key',
    });
    return secret;
  }
  const { secret } = await apiKeyService.createCloudHostScopedKey({
    accountId,
    ownerType,
    ownerId,
    name: 'host-key',
    cloudHostId: input.cloudHostId!,
  });
  return secret;
}

async function probe(secret?: string): Promise<Response> {
  return fetch(`${baseUrl}/probe`, {
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
  });
}

describe('billingKeyAuth（CLOUD_HOST Key 实时失效）', () => {
  beforeAll(async () => {
    await connectTestDb();
    await startGateway();
  }, 60000);

  afterAll(async () => {
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  it('T-BK5: 宿主 RUNNING 时放行，并注入 scope/cloudHostId', async () => {
    const cloudHostId = await seedCloudHost({ status: 'RUNNING' });
    const secret = await seedKey({ scope: 'cloud_host', cloudHostId });

    const res = await probe(secret);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      billing: { scope: string; cloudHostId: string; expiresAt: string | null };
    };
    expect(body.billing.scope).toBe('cloud_host');
    expect(body.billing.cloudHostId).toBe(cloudHostId);
    // 新 Key 不再写固定有效期（随容器回收）。
    expect(body.billing.expiresAt).toBeNull();
  });

  it('T-BK5: 创建窗口 STARTING 拒绝（401 invalid_api_key）', async () => {
    const cloudHostId = await seedCloudHost({ status: 'STARTING' });
    const secret = await seedKey({ scope: 'cloud_host', cloudHostId });

    const res = await probe(secret);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('T-BK5: 宿主 STOPPED/FAILED 拒绝', async () => {
    for (const status of ['STOPPED', 'FAILED']) {
      const cloudHostId = await seedCloudHost({ status });
      const secret = await seedKey({ scope: 'cloud_host', cloudHostId });
      expect((await probe(secret)).status).toBe(401);
    }
  });

  it('T-BK5: 宿主不存在 / 已软删除拒绝', async () => {
    const missingSecret = await seedKey({
      scope: 'cloud_host',
      cloudHostId: new mongoose.Types.ObjectId().toString(),
    });
    expect((await probe(missingSecret)).status).toBe(401);

    const deletedHostId = await seedCloudHost({ deletedAt: new Date() });
    const deletedSecret = await seedKey({ scope: 'cloud_host', cloudHostId: deletedHostId });
    expect((await probe(deletedSecret)).status).toBe(401);
  });

  it('B-2: owner 与宿主属主不一致 → 401（防跨用户 Key 复用）', async () => {
    const cloudHostId = await seedCloudHost({ status: 'RUNNING', userId: 'other-user' });
    const secret = await seedKey({ scope: 'cloud_host', cloudHostId });

    const res = await probe(secret);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('多租户二期：团队租户 tenantId 一致时放行（userId 与 tenantId 不同）', async () => {
    const tenantId = new mongoose.Types.ObjectId().toString();
    const cloudHostId = await seedCloudHost({
      status: 'RUNNING',
      userId: new mongoose.Types.ObjectId().toString(),
      tenantId,
    });
    const secret = await seedKey({
      scope: 'cloud_host',
      cloudHostId,
      ownerType: 'tenant',
      ownerId: tenantId,
    });

    expect((await probe(secret)).status).toBe(200);
  });

  it('多租户二期：团队租户 tenantId 不一致 → 401（userId 相同也不放行）', async () => {
    const tenantId = new mongoose.Types.ObjectId().toString();
    const userId = new mongoose.Types.ObjectId().toString();
    const cloudHostId = await seedCloudHost({ status: 'RUNNING', userId, tenantId });

    const otherTenant = await seedKey({
      scope: 'cloud_host',
      cloudHostId,
      ownerType: 'tenant',
      ownerId: new mongoose.Types.ObjectId().toString(),
    });
    expect((await probe(otherTenant)).status).toBe(401);

    // 是否是云电脑创建者不影响租户维度归属
    const creatorUserId = await seedKey({
      scope: 'cloud_host',
      cloudHostId,
      ownerType: 'tenant',
      ownerId: userId,
    });
    expect((await probe(creatorUserId)).status).toBe(401);
  });

  it('B-2: admin_user 豁免属主一致性校验（后台代运行）', async () => {
    // 宿主属主为 probe-user，但 admin_user Key 不参与 ownerId 绑定校验。
    const cloudHostId = await seedCloudHost({ status: 'RUNNING', userId: 'probe-user' });
    const { secret } = await apiKeyService.createCloudHostScopedKey({
      accountId: new mongoose.Types.ObjectId().toString(),
      ownerType: 'admin_user',
      ownerId: 'admin-1',
      name: 'admin-host-key',
      cloudHostId,
    });

    const res = await probe(secret);
    expect(res.status).toBe(200);
  });

  it('T-BK4: 历史遗留的过期 Key 仍拒绝（兼容旧数据）', async () => {
    const cloudHostId = await seedCloudHost({ status: 'RUNNING' });
    const secret = await seedKey({
      scope: 'cloud_host',
      cloudHostId,
    });
    await mongoose.connection.db!.collection('billingapikeys').updateMany(
      { scope: 'cloud_host' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect((await probe(secret)).status).toBe(401);
  });

  it('T-BK1: 账号 Key 不查云电脑，行为不变', async () => {
    const secret = await seedKey({ scope: 'account' });
    const res = await probe(secret);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { billing: { scope: string; cloudHostId: string | null } };
    expect(body.billing.scope).toBe('account');
    expect(body.billing.cloudHostId).toBeNull();
  });

  it('回归：缺少/非法 Key 仍 401', async () => {
    expect((await probe()).status).toBe(401);
    expect((await probe('zag_sk_ffffffffffffffffffffffffffffffff')).status).toBe(401);
  });
});
