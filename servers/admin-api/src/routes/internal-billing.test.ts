import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { createInternalBillingRouter } from './internal-billing.js';
import { config } from '../config/index.js';
import { BillingApiKey } from '../models/billing-api-key.js';
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

function owner() {
  return {
    ownerType: 'front_user',
    ownerId: new mongoose.Types.ObjectId().toString(),
    name: 'key',
  };
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

  it('T-BK2: 云电脑 Key 接受 scope/cloudHostId/expiresAt 并落库', async () => {
    const cloudHostId = new mongoose.Types.ObjectId().toString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const res = await post('/api-keys', {
      ...owner(),
      scope: 'cloud_host',
      cloudHostId,
      expiresAt: expiresAt.toISOString(),
    });
    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      apiKey: {
        id: string;
        scope: string;
        cloudHostId: string;
        expiresAt: string;
      };
      secret: string;
    };
    expect(payload.apiKey.scope).toBe('cloud_host');
    expect(payload.apiKey.cloudHostId).toBe(cloudHostId);
    expect(payload.apiKey.expiresAt).toBe(expiresAt.toISOString());

    const verified = await apiKeyService.verify(payload.secret);
    expect(verified?.scope).toBe('cloud_host');
    expect(verified?.cloudHostId).toBe(cloudHostId);
  });

  it('T-BK2: 云电脑 Key 参数非法（缺 cloudHostId / 非法有效期 / 非法 scope）→ 400', async () => {
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
    expect(
      (
        await post('/api-keys', {
          ...base,
          scope: 'cloud_host',
          cloudHostId: new mongoose.Types.ObjectId().toString(),
        })
      ).status,
    ).toBe(400);
    expect((await post('/api-keys', { ...base, scope: 'root' })).status).toBe(400);
  });

  it('T-BK6: POST /api-keys/:id/revoke 幂等，未知 id 404，不要求 owner', async () => {
    const created = await apiKeyService.createCloudHostScopedKey({
      accountId: new mongoose.Types.ObjectId().toString(),
      ownerType: 'front_user',
      ownerId: new mongoose.Types.ObjectId().toString(),
      name: 'k',
      cloudHostId: new mongoose.Types.ObjectId().toString(),
      expiresAt: new Date(Date.now() + 60_000),
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
        expiresAt: new Date(Date.now() + 60_000),
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
});
