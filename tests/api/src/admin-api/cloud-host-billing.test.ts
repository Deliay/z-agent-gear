import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';

// 云电脑运行 Key：内部铸造 → 网关实时失效 → 按宿主撤销。
// 需要 admin-api 就绪 + INTERNAL_API_TOKEN + MONGODB_URI。
const ADMIN_GRAPHQL = process.env.ADMIN_API_URL || 'http://localhost:10003/graphql';
const ADMIN_BASE = ADMIN_GRAPHQL.replace(/\/graphql\/?$/, '');
const TOKEN = process.env.INTERNAL_API_TOKEN;
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

function internal(path: string, init: RequestInit = {}) {
  return fetch(`${ADMIN_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function models(secret: string) {
  return fetch(`${ADMIN_BASE}/v1/models`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
}

describe.skipIf(!TOKEN || !HAS_MONGO)('Admin cloud host billing key', () => {
  it('mints cloud_host key, gates on host status, revokes by host', async () => {
    const db = (await mongoDb())!;
    const userId = new mongoose.Types.ObjectId().toString();
    const cloudHostId = new mongoose.Types.ObjectId().toString();
    const now = new Date();
    await db.collection('cloudhosts').insertOne({
      _id: new mongoose.Types.ObjectId(cloudHostId),
      userId: new mongoose.Types.ObjectId(userId),
      name: 'billing-test',
      harnessTypes: ['OPENCODE'],
      status: 'STARTING',
      controllerId: new mongoose.Types.ObjectId(),
      keyId: new mongoose.Types.ObjectId(),
      workspaceId: new mongoose.Types.ObjectId(),
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const minted = await internal('/internal/billing/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        ownerType: 'front_user',
        ownerId: userId,
        name: 'cloud-key',
        scope: 'cloud_host',
        cloudHostId,
        expiresAt,
      }),
    });
    expect(minted.status).toBe(201);
    const payload = (await minted.json()) as {
      secret: string;
      apiKey: { id: string; scope: string; cloudHostId: string; expiresAt: string };
    };
    expect(payload.secret).toMatch(/^zag_sk_[0-9a-f]+$/);
    expect(payload.apiKey).toMatchObject({ scope: 'cloud_host', cloudHostId });
    expect(payload.apiKey.expiresAt).toBe(expiresAt);

    // STARTING 窗口内模型网关必须拒绝（初始化不调用模型）
    expect((await models(payload.secret)).status).toBe(401);

    await db
      .collection('cloudhosts')
      .updateOne({ _id: new mongoose.Types.ObjectId(cloudHostId) }, { $set: { status: 'RUNNING' } });
    expect((await models(payload.secret)).status).toBe(200);

    // 软删除立即失效
    await db
      .collection('cloudhosts')
      .updateOne({ _id: new mongoose.Types.ObjectId(cloudHostId) }, { $set: { deletedAt: now } });
    expect((await models(payload.secret)).status).toBe(401);

    await db
      .collection('cloudhosts')
      .updateOne({ _id: new mongoose.Types.ObjectId(cloudHostId) }, { $set: { deletedAt: null } });
    const revoked = await internal('/internal/billing/api-keys/revoke-by-host', {
      method: 'POST',
      body: JSON.stringify({ cloudHostId }),
    });
    expect(revoked.status).toBe(200);
    expect((await models(payload.secret)).status).toBe(401);

    // 过期 Key 即使宿主 RUNNING 也 401
    const second = await internal('/internal/billing/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        ownerType: 'front_user',
        ownerId: userId,
        name: 'cloud-key-2',
        scope: 'cloud_host',
        cloudHostId,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    });
    const secondPayload = (await second.json()) as { secret: string };
    await db.collection('billingapikeys').updateMany(
      { cloudHostId: new mongoose.Types.ObjectId(cloudHostId), status: 'active' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect((await models(secondPayload.secret)).status).toBe(401);

    // 幂等
    expect(
      (
        await internal('/internal/billing/api-keys/revoke-by-host', {
          method: 'POST',
          body: JSON.stringify({ cloudHostId }),
        })
      ).status,
    ).toBe(200);

    await db.collection('billingapikeys').deleteMany({ cloudHostId: new mongoose.Types.ObjectId(cloudHostId) });
    await db.collection('cloudhosts').deleteOne({ _id: new mongoose.Types.ObjectId(cloudHostId) });
  });

  it('rejects cloud_host key mint without host/expiry', async () => {
    const missingHost = await internal('/internal/billing/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        ownerType: 'front_user',
        ownerId: new mongoose.Types.ObjectId().toString(),
        name: 'bad',
        scope: 'cloud_host',
        expiresAt: new Date().toISOString(),
      }),
    });
    expect(missingHost.status).toBe(400);

    const missingExpiry = await internal('/internal/billing/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        ownerType: 'front_user',
        ownerId: new mongoose.Types.ObjectId().toString(),
        name: 'bad',
        scope: 'cloud_host',
        cloudHostId: new mongoose.Types.ObjectId().toString(),
      }),
    });
    expect(missingExpiry.status).toBe(400);
  });
});
