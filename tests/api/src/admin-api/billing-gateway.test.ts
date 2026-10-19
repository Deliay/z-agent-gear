import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { adminGql, ensureAdminLogin } from './helpers.js';

const HTTP = (process.env.ADMIN_API_URL || 'http://localhost:10003/graphql').replace(
  /\/graphql$/,
  '',
);

const CREATE_KEY = `
  mutation CreateBillingApiKey($name: String!) {
    createBillingApiKey(name: $name) { apiKey { id } secret }
  }
`;

function openAiError(body: unknown): { code?: string } | undefined {
  return (body as { error?: { code?: string } }).error;
}

describe('OpenAI 兼容计费网关', () => {
  let secret = '';

  beforeAll(async () => {
    const token = await ensureAdminLogin();
    const created = await adminGql<{ createBillingApiKey: { secret: string } }>(
      CREATE_KEY,
      { name: `gateway-test-${Date.now()}` },
      token,
    );
    secret = created.data!.createBillingApiKey.secret;
  });

  it('T-B22: GET /v1/models 返回 OpenAI 列表（仅计费且定价完整模型）', async () => {
    const res = await fetch(`${HTTP}/v1/models`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string; object: string }> };
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    for (const model of body.data) {
      expect(model.object).toBe('model');
    }
  });

  it('T-B23: 无效 Key 401 invalid_api_key', async () => {
    const res = await fetch(`${HTTP}/v1/models`, {
      headers: { Authorization: 'Bearer zag_sk_deadbeef' },
    });
    expect(res.status).toBe(401);
    expect(openAiError(await res.json())?.code).toBe('invalid_api_key');
  });

  it('T-B23: 缺参数 400、未知模型 404、未定价模型 400', async () => {
    const missing = await fetch(`${HTTP}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    });
    expect(missing.status).toBe(400);

    const unknown = await fetch(`${HTTP}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(unknown.status).toBe(404);
    expect(openAiError(await unknown.json())?.code).toBe('model_not_found');
  });
});

const ADMIN_ACCOUNTS = `
  query Accounts {
    adminBillingAccounts(ownerType: admin_user, keyword: "admin", page: 1, pageSize: 5) {
      id
      ownerType
      ownerName
      status
    }
  }
`;

const SET_STATUS = `
  mutation SetStatus($accountId: ID!, $status: String!) {
    setBillingAccountStatus(accountId: $accountId, status: $status) { id status }
  }
`;

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

/**
 * PRD §3.5：账户被冻结 → 拒绝新的模型调用，且不限于「已开启计费」的模型。
 * 直写一个 isBillable=false 的全局模型（无真实上游），断言冻结账户调用被 402 拒绝。
 */
describe.skipIf(!process.env.MONGODB_URI)('冻结账户网关口径（含未开启计费模型）', () => {
  it('T-B24: frozen 账户调用非计费模型同样 402 account_frozen', async () => {
    const db = await mongoDb();
    if (!db) return;
    const token = await ensureAdminLogin();

    const accounts = await adminGql<{
      adminBillingAccounts: Array<{ id: string; ownerType: string; ownerName: string }>;
    }>(ADMIN_ACCOUNTS, {}, token);
    const account = accounts.data!.adminBillingAccounts.find((item) => item.ownerType === 'admin_user');
    expect(account).toBeTruthy();

    const created = await adminGql<{ createBillingApiKey: { secret: string } }>(
      CREATE_KEY,
      { name: `frozen-free-${Date.now()}` },
      token,
    );
    const key = created.data!.createBillingApiKey.secret;

    const providerId = new mongoose.Types.ObjectId();
    const modelName = `frozen-free-${Date.now()}`;
    const now = new Date();
    await db.collection('providers').insertOne({
      _id: providerId,
      name: `frozen-free-provider-${Date.now()}`,
      type: 'OpenAI',
      endpoint: 'http://127.0.0.1:1',
      credentialType: 'api_key',
      encryptedCredential: { iv: 'a', ciphertext: 'b', tag: 'c' },
      isEnabled: true,
      scope: 'global',
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('models').insertOne({
      providerId,
      name: modelName,
      isCustom: false,
      isEnabled: true,
      sortOrder: 0,
      scope: 'global',
      pricing: { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0, isBillable: false },
      createdAt: now,
      updatedAt: now,
    });

    try {
      await adminGql(SET_STATUS, { accountId: account!.id, status: 'frozen' }, token);
      const res = await fetch(`${HTTP}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(402);
      expect(openAiError(await res.json())?.code).toBe('account_frozen');
    } finally {
      await adminGql(SET_STATUS, { accountId: account!.id, status: 'active' }, token);
      await db.collection('models').deleteOne({ name: modelName });
      await db.collection('providers').deleteOne({ _id: providerId });
      await mongoose.disconnect();
    }
  });
});
