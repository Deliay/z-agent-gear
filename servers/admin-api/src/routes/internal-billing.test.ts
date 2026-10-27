import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { createInternalBillingRouter } from './internal-billing.js';
import { config } from '../config/index.js';
import { BillingApiKey } from '../models/billing-api-key.js';
import { BillingAccount } from '../models/billing-account.js';
import { apiKeyService } from '../services/billing/api-key-service.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../services/billing/testing/mongo.js';

const TOKEN = 'internal-test-token';
let server: Server;
let baseUrl = '';

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/internal/billing', createInternalBillingRouter());
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

async function post(
  path: string,
  body: unknown,
  token: string | null = TOKEN,
): Promise<Response> {
  return fetch(`${baseUrl}/internal/billing${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function get(path: string, token: string | null = TOKEN): Promise<Response> {
  return fetch(`${baseUrl}/internal/billing${path}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

function owner() {
  return {
    ownerType: 'tenant',
    ownerId: new mongoose.Types.ObjectId().toString(),
    name: 'key',
  };
}

/** 只读模型口径：cloudhosts 由 agent-api 写入，测试用原生集合插入。 */
async function seedCloudHost(
  userId: string,
  options: { deletedAt?: Date | null } = {},
): Promise<string> {
  const _id = new mongoose.Types.ObjectId();
  await mongoose.connection.db!.collection('cloudhosts').insertOne({
    _id,
    userId: new mongoose.Types.ObjectId(userId),
    controllerId: new mongoose.Types.ObjectId(),
    status: 'RUNNING',
    deletedAt: options.deletedAt ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return _id.toString();
}

describe('internal-billing /api-keys（云电脑 Key 铸造与撤销）', () => {
  beforeAll(async () => {
    await connectTestDb();
    config.internalApiToken = TOKEN;
    await startServer();
  }, 60000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
  });

  it('T-BK8: 无/错误 INTERNAL_API_TOKEN 一律 401', async () => {
    expect((await post('/api-keys', owner(), null)).status).toBe(401);
    expect((await post('/api-keys', owner(), 'wrong-token')).status).toBe(401);
    expect((await post(`/api-keys/${new mongoose.Types.ObjectId()}/revoke`, {}, null)).status).toBe(401);
    expect((await post('/api-keys/revoke-by-host', { cloudHostId: 'x' }, 'wrong')).status).toBe(401);
  });

  it('T-BK1: 账号 Key 默认 scope=account，返回可校验明文', async () => {
    const body = owner();
    const res = await post('/api-keys', body);
    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      apiKey: {
        id: string;
        scope: string;
        cloudHostId: string | null;
        expiresAt: string | null;
        createdAt: string;
      };
      secret: string;
    };
    expect(payload.apiKey.scope).toBe('account');
    expect(payload.apiKey.cloudHostId).toBeNull();
    expect(payload.apiKey.expiresAt).toBeNull();
    expect((await apiKeyService.verify(payload.secret))?.scope).toBe('account');
  });

  it('T-BK2: 云电脑 Key 接受 scope/cloudHostId，旧版 expiresAt 被忽略（不落有效期）', async () => {
    const base = owner();
    const cloudHostId = await seedCloudHost(base.ownerId);
    const res = await post('/api-keys', {
      ...base,
      scope: 'cloud_host',
      cloudHostId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      apiKey: {
        id: string;
        scope: string;
        cloudHostId: string;
        expiresAt: string | null;
      };
      secret: string;
    };
    expect(payload.apiKey.scope).toBe('cloud_host');
    expect(payload.apiKey.cloudHostId).toBe(cloudHostId);
    // 云电脑 Key 随容器回收，不再按时间过期。
    expect(payload.apiKey.expiresAt).toBeNull();

    const verified = await apiKeyService.verify(payload.secret);
    expect(verified?.scope).toBe('cloud_host');
    expect(verified?.cloudHostId).toBe(cloudHostId);
    expect(verified?.expiresAt).toBeNull();
  });

  it('T-BK2: 云电脑 Key 参数非法（缺 cloudHostId / 非法 scope / 非法 expiresAt）→ 400', async () => {
    const base = owner();
    expect((await post('/api-keys', { ...base, scope: 'cloud_host' })).status).toBe(400);
    expect(
      (
        await post('/api-keys', {
          ...base,
          scope: 'cloud_host',
          cloudHostId: 'not-an-object-id',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post('/api-keys', {
          ...base,
          scope: 'cloud_host',
          cloudHostId: new mongoose.Types.ObjectId().toString(),
          expiresAt: 'not-a-date',
        })
      ).status,
    ).toBe(400);
    expect((await post('/api-keys', { ...base, scope: 'root' })).status).toBe(400);
  });

  it('B-5: 云电脑 Key 铸造校验 cloudHostId↔ownerId 绑定（不存在/属主不符/已软删 → 404）', async () => {
    const base = owner();
    const body = (cloudHostId: string) => ({
      ...base,
      scope: 'cloud_host',
      cloudHostId,
    });

    // 宿主不存在
    const missing = await post('/api-keys', body(new mongoose.Types.ObjectId().toString()));
    expect(missing.status).toBe(404);
    expect((await missing.json()) as { error: string }).toEqual({ error: 'CLOUD_HOST_NOT_FOUND' });

    // 宿主属主与 ownerId 不一致
    const otherHostId = await seedCloudHost(new mongoose.Types.ObjectId().toString());
    const mismatch = await post('/api-keys', body(otherHostId));
    expect(mismatch.status).toBe(404);
    expect((await mismatch.json()) as { error: string }).toEqual({ error: 'CLOUD_HOST_NOT_FOUND' });
    // R2-16：拒绝时不得留下任何 Key 记录
    expect(await BillingApiKey.countDocuments({ cloudHostId: otherHostId })).toBe(0);

    // R2-14：admin_user 与网关口径一致保留管理豁免（可代任意宿主铸造）
    const adminHostId = await seedCloudHost(new mongoose.Types.ObjectId().toString());
    const admin = await post('/api-keys', {
      ...base,
      ownerType: 'admin_user',
      ownerId: new mongoose.Types.ObjectId().toString(),
      scope: 'cloud_host',
      cloudHostId: adminHostId,
    });
    expect(admin.status).toBe(201);

    // 宿主已软删除
    const deletedHostId = await seedCloudHost(base.ownerId, { deletedAt: new Date() });
    const deleted = await post('/api-keys', body(deletedHostId));
    expect(deleted.status).toBe(404);

    // 绑定一致才允许铸造
    const ownHostId = await seedCloudHost(base.ownerId);
    const ok = await post('/api-keys', body(ownHostId));
    expect(ok.status).toBe(201);
  });

  it('T-BK6: POST /api-keys/:id/revoke 幂等，未知 id 404，不要求 owner', async () => {
    const created = await apiKeyService.createCloudHostScopedKey({
      accountId: new mongoose.Types.ObjectId().toString(),
      ownerType: 'front_user',
      ownerId: new mongoose.Types.ObjectId().toString(),
      name: 'k',
      cloudHostId: new mongoose.Types.ObjectId().toString(),
    });

    const first = await post(`/api-keys/${created.apiKey.id}/revoke`, {});
    expect(first.status).toBe(200);
    expect((await first.json()) as { apiKey: { status: string } }).toMatchObject({
      apiKey: { status: 'revoked' },
    });
    // 幂等
    const second = await post(`/api-keys/${created.apiKey.id}/revoke`, {});
    expect(second.status).toBe(200);
    expect((await second.json()) as { apiKey: { status: string } }).toMatchObject({
      apiKey: { status: 'revoked' },
    });
    // 明文即刻失效
    expect(await apiKeyService.verify(created.secret)).toBeNull();

    const unknown = await post(`/api-keys/${new mongoose.Types.ObjectId()}/revoke`, {});
    expect(unknown.status).toBe(404);
  });

  it('T-BK7: POST /api-keys/revoke-by-host 撤销同宿主全部 active，重复调用幂等', async () => {
    const cloudHostId = new mongoose.Types.ObjectId().toString();
    const otherHostId = new mongoose.Types.ObjectId().toString();
    const accountId = new mongoose.Types.ObjectId().toString();
    for (const id of [cloudHostId, cloudHostId, otherHostId]) {
      await BillingApiKey.create({
        accountId,
        ownerType: 'front_user',
        ownerId: 'u',
        name: 'k',
        keyPrefix: `zag_sk_${Math.random().toString(16).slice(2, 11)}`,
        keyHash: 'h',
        scope: 'cloud_host',
        cloudHostId: id,
      });
    }

    const first = await post('/api-keys/revoke-by-host', { cloudHostId });
    expect(first.status).toBe(200);
    expect((await first.json()) as { success: boolean; revoked: number }).toEqual({
      success: true,
      revoked: 2,
    });
    expect(await BillingApiKey.countDocuments({ cloudHostId, status: 'active' })).toBe(0);
    expect(await BillingApiKey.countDocuments({ cloudHostId: otherHostId, status: 'active' })).toBe(1);

    const second = await post('/api-keys/revoke-by-host', { cloudHostId });
    expect(second.status).toBe(200);
    expect((await second.json()) as { revoked: number }).toMatchObject({ revoked: 0 });

    expect((await post('/api-keys/revoke-by-host', { cloudHostId: 'bad' })).status).toBe(400);
  });

  it('T-IB-CH1: /charges 扣费成功并返回账单与收据', async () => {
    const account = await BillingAccount.create({
      ownerType: 'front_user',
      ownerId: new mongoose.Types.ObjectId().toString(),
      ownerName: 'alice',
      cashBalance: 1000,
    });
    const res = await post('/charges', {
      accountId: String(account._id),
      productId: 'cloud_host.create',
      quantity: 1,
      idempotentKey: 'cloud_host.create:h1',
      refType: 'cloud_host',
      refId: 'h1',
      description: '创建云电脑 test',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      charged: boolean;
      invoice: { amount: number };
      receipt: { id: string };
    };
    expect(body.charged).toBe(true);
    expect(body.invoice.amount).toBe(-500);
    expect(body.receipt.id).toBeTruthy();
    expect((await BillingAccount.findById(account._id))?.cashBalance).toBe(500);
  });

  it('T-IB-CH2: 未授权 401；余额不足 409 INSUFFICIENT_BALANCE 带 available', async () => {
    expect(
      (await post('/charges', { accountId: new mongoose.Types.ObjectId().toString() }, null)).status,
    ).toBe(401);
    const account = await BillingAccount.create({
      ownerType: 'front_user',
      ownerId: new mongoose.Types.ObjectId().toString(),
      ownerName: 'poor',
      cashBalance: 100,
    });
    const res = await post('/charges', {
      accountId: String(account._id),
      productId: 'cloud_host.create',
      quantity: 1,
      idempotentKey: 'cloud_host.create:poor',
      refType: 'cloud_host',
      refId: 'poor',
      description: '创建云电脑 poor',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'INSUFFICIENT_BALANCE', available: 1 });
    expect((await post('/charges', {})).status).toBe(400);
  });

  it('T-IB-RF1/T-IB-PQ1: /refunds 幂等；/price-quote 缺档回落', async () => {
    const account = await BillingAccount.create({
      ownerType: 'front_user',
      ownerId: new mongoose.Types.ObjectId().toString(),
      ownerName: 'bob',
      cashBalance: 1000,
    });
    const chargeBody = {
      accountId: String(account._id),
      productId: 'cloud_host.create',
      quantity: 1,
      idempotentKey: 'cloud_host.create:h2',
      refType: 'cloud_host',
      refId: 'h2',
      description: '创建云电脑 refund',
    };
    expect((await post('/charges', chargeBody)).status).toBe(200);
    const refundBody = {
      idempotentKey: 'cloud_host.create:h2',
      refundKey: 'cloud_host.create.refund:h2',
      reason: 'start failed',
    };
    const first = await post('/refunds', refundBody);
    expect(first.status).toBe(200);
    expect((await BillingAccount.findById(account._id))?.cashBalance).toBe(1000);
    expect((await post('/refunds', refundBody)).status).toBe(200);
    expect((await BillingAccount.findById(account._id))?.cashBalance).toBe(1000);

    const quote = await fetch(
      `${baseUrl}/internal/billing/price-quote?productIds=cloud_host.create,container.minute`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(quote.status).toBe(200);
    expect(await quote.json()).toEqual([
      { productId: 'cloud_host.create', unitPrice: 5, currency: 'credits' },
      { productId: 'container.minute', unitPrice: 1, currency: 'credits' },
    ]);
  });

  it('T-B-OWNER1: 读请求 front_user 兼容解析到同 ownerId 的 tenant 行', async () => {
    const ownerId = new mongoose.Types.ObjectId().toString();
    // 迁移后存量行已是 tenant；旧 agent-api 仍可能传 front_user 读取。
    const created = await BillingAccount.create({
      ownerType: 'tenant',
      ownerId,
      ownerName: '租户 A',
      cashBalance: 500,
    });

    const res = await get(`/account?ownerType=front_user&ownerId=${ownerId}`);
    expect(res.status).toBe(200);
    const account = (await res.json()) as { id: string; ownerType: string; ownerId: string; cashBalance: number };
    expect(account).toMatchObject({
      id: String(created._id),
      ownerType: 'tenant',
      ownerId,
      cashBalance: 5,
    });
    // 不新增 front_user 行
    expect(await BillingAccount.countDocuments({ ownerType: 'front_user' })).toBe(0);

    // tenant 与 admin_user 读口径原样可用
    expect((await get(`/account?ownerType=tenant&ownerId=${ownerId}`)).status).toBe(200);
    const adminRes = await get(
      `/account?ownerType=admin_user&ownerId=${new mongoose.Types.ObjectId().toString()}`,
    );
    expect(adminRes.status).toBe(200);
    expect(((await adminRes.json()) as { ownerType: string }).ownerType).toBe('admin_user');
  });

  it('T-B-OWNER2: 写请求（账户/Key 创建、撤销）拒绝已废弃 front_user → 400 INVALID_OWNER_TYPE', async () => {
    const body = { ...owner(), ownerType: 'front_user' };
    const created = await post('/api-keys', body);
    expect(created.status).toBe(400);
    expect((await created.json()) as { error: string }).toEqual({ error: 'INVALID_OWNER_TYPE' });

    const deleted = await fetch(
      `${baseUrl}/internal/billing/api-keys/${new mongoose.Types.ObjectId()}?ownerType=front_user&ownerId=x`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(deleted.status).toBe(400);
    expect((await deleted.json()) as { error: string }).toEqual({ error: 'INVALID_OWNER_TYPE' });
  });

  it('T-B-OWNER3: GET /api-keys 兼容 front_user（命中 tenant 归属的 Key）', async () => {
    const base = owner();
    expect((await post('/api-keys', base)).status).toBe(201);

    const res = await get(`/api-keys?ownerType=front_user&ownerId=${base.ownerId}`);
    expect(res.status).toBe(200);
    const keys = (await res.json()) as Array<{ name: string }>;
    expect(keys).toHaveLength(1);
    expect(keys[0].name).toBe('key');
    expect(await BillingApiKey.countDocuments({ ownerType: 'tenant', ownerId: base.ownerId })).toBe(1);
  });
});
