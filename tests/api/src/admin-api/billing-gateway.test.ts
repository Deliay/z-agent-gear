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

  it('T-B21: GET /v1/models 返回 OpenAI list 信封（形状）', async () => {
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

  it('T-B25: 无效 Key 401 invalid_api_key', async () => {
    const res = await fetch(`${HTTP}/v1/models`, {
      headers: { Authorization: 'Bearer zag_sk_deadbeef' },
    });
    expect(res.status).toBe(401);
    expect(openAiError(await res.json())?.code).toBe('invalid_api_key');
  });

  it('T-B26: 缺参数 400、未知模型 404', async () => {
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

/**
 * T-2：T-B22/T-B23 名实相符——`/v1/models` 过滤逻辑与 `model_not_priced` 分支必须被真实断言，
 * 而不是「删掉过滤逻辑也照样通过」。直写 `models`（需 MONGODB_URI）。
 */
describe.skipIf(!process.env.MONGODB_URI)('计费网关分支覆盖（直写模型）', () => {
  let secret = '';
  const providerId = new mongoose.Types.ObjectId();
  const createdNames: string[] = [];

  beforeAll(async () => {
    const db = await mongoDb();
    if (!db) return;
    const token = await ensureAdminLogin();
    const created = await adminGql<{ createBillingApiKey: { secret: string } }>(
      CREATE_KEY,
      { name: `gateway-filter-${Date.now()}` },
      token,
    );
    secret = created.data!.createBillingApiKey.secret;

    const now = new Date();
    await db.collection('providers').insertOne({
      _id: providerId,
      name: `gateway-provider-${Date.now()}`,
      type: 'OpenAI',
      endpoint: 'http://127.0.0.1:1',
      credentialType: 'api_key',
      encryptedCredential: { iv: 'a', ciphertext: 'b', tag: 'c' },
      isEnabled: true,
      scope: 'global',
      createdAt: now,
      updatedAt: now,
    });
    const seedModel = async (
      name: string,
      pricing: { inputPerMillion: number; cachedInputPerMillion: number; outputPerMillion: number; isBillable: boolean } | null,
    ) => {
      createdNames.push(name);
      await db.collection('models').insertOne({
        providerId,
        name,
        isCustom: false,
        isEnabled: true,
        sortOrder: 0,
        scope: 'global',
        pricing,
        createdAt: now,
        updatedAt: now,
      });
    };
    await seedModel(`priced-${Date.now()}`, {
      inputPerMillion: 1,
      cachedInputPerMillion: 0,
      outputPerMillion: 1,
      isBillable: true,
    });
    await seedModel(`not-billable-${Date.now()}`, {
      inputPerMillion: 1,
      cachedInputPerMillion: 0,
      outputPerMillion: 1,
      isBillable: false,
    });
    await seedModel(`unpriced-${Date.now()}`, {
      inputPerMillion: 0,
      cachedInputPerMillion: 0,
      outputPerMillion: 0,
      isBillable: true,
    });
    const noPricingName = `no-pricing-${Date.now()}`;
    createdNames.push(noPricingName);
    await db.collection('models').insertOne({
      providerId,
      name: noPricingName,
      isCustom: false,
      isEnabled: true,
      sortOrder: 0,
      scope: 'global',
      pricing: null,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    const db = await mongoDb();
    if (!db) return;
    await db.collection('models').deleteMany({ name: { $in: createdNames } });
    await db.collection('providers').deleteOne({ _id: providerId });
    await mongoose.disconnect();
  });

  it('T-B27: /v1/models 排除未定价 / 非计费（含全 0 价目档）模型', async () => {
    const db = await mongoDb();
    if (!db) return;
    const res = await fetch(`${HTTP}/v1/models`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((model) => model.id);
    for (const name of createdNames) {
      // 已定价且可计费的模型应存在；其余三类必须被过滤。
      if (name.startsWith('priced-')) {
        expect(ids).toContain(name);
      } else {
        expect(ids).not.toContain(name);
      }
    }
  });

  it('T-B28: 未定价（pricing:null 与全 0 档）模型 400 model_not_priced', async () => {
    const db = await mongoDb();
    if (!db) return;
    for (const prefix of ['^no-pricing-', '^unpriced-']) {
      const model = await db.collection('models').findOne({ name: { $regex: prefix } });
      expect(model).toBeTruthy();
      const res = await fetch(`${HTTP}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: (model as { name: string }).name,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(400);
      expect(openAiError(await res.json())?.code).toBe('model_not_priced');
    }
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
