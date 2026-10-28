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

  it('T-B29: 无效 Key 401 invalid_api_key', async () => {
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
 * T-2/R3-5：T-B27/T-B28 名实相符——`/v1/models` 过滤逻辑与 `model_not_priced` 分支必须被真实断言，
 * 而不是「删掉过滤逻辑也照样通过」。直写 `models`（需 MONGODB_URI）。
 */
describe('计费网关分支覆盖（直写模型，MONGODB_URI 缺失即失败）', () => {
  let secret = '';
  const providerId = new mongoose.Types.ObjectId();
  const createdNames: string[] = [];

  beforeAll(async () => {
    // 缺 MONGODB_URI 时不在 beforeAll 抛错（否则 vitest 把用例标 skipped）：
    // 直接返回，让每个用例体内的显式断言失败（缺参即红）。
    if (!process.env.MONGODB_URI) return;
    const db = (await mongoDb())!;
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
    const db = (await mongoDb())!;
    await db.collection('models').deleteMany({ name: { $in: createdNames } });
    await db.collection('providers').deleteOne({ _id: providerId });
    await mongoose.disconnect();
  });

  it('T-CL-GW1: /v1/models 两口径下发 context_length，未设置省略，清空后消失', async () => {
    expect(process.env.MONGODB_URI, 'MONGODB_URI 必须注入，T-CL-GW1 不允许静默 skip').toBeTruthy();
    const internalToken = process.env.INTERNAL_API_TOKEN;
    expect(internalToken, 'INTERNAL_API_TOKEN 必须注入以验证 cloud_host 口径').toBeTruthy();
    const db = (await mongoDb())!;

    const stamp = Date.now();
    // 以 priced- 前缀命名，复用 T-B27「已定价模型应出现在列表」的既有断言口径
    const withContext = `priced-ctx-with-${stamp}`;
    const withoutContext = `priced-ctx-without-${stamp}`;
    createdNames.push(withContext, withoutContext);
    const now = new Date();
    const pricing = {
      inputPerMillion: 1,
      cachedInputPerMillion: 0,
      outputPerMillion: 1,
      isBillable: true,
    };
    await db.collection('models').insertMany([
      {
        providerId,
        name: withContext,
        isCustom: false,
        isEnabled: true,
        sortOrder: 0,
        scope: 'global',
        contextLength: 200000,
        pricing,
        createdAt: now,
        updatedAt: now,
      },
      {
        providerId,
        name: withoutContext,
        isCustom: false,
        isEnabled: true,
        sortOrder: 0,
        scope: 'global',
        contextLength: null,
        pricing,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // cloud_host Key：内部接口铸造（与运行时同口径）
    const cloudHostId = new mongoose.Types.ObjectId().toString();
    const userId = new mongoose.Types.ObjectId().toString();
    await db.collection('cloudhosts').insertOne({
      _id: new mongoose.Types.ObjectId(cloudHostId),
      userId: new mongoose.Types.ObjectId(userId),
      tenantId: new mongoose.Types.ObjectId(userId),
      name: `gw-host-${stamp}`,
      harnessTypes: ['OPENCODE'],
      status: 'RUNNING',
      controllerId: new mongoose.Types.ObjectId(),
      keyId: new mongoose.Types.ObjectId(),
      workspaceId: new mongoose.Types.ObjectId(),
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    let cloudHostKey = '';
    try {
      const minted = await fetch(`${HTTP.replace(/\/v1\/models$/, '')}/internal/billing/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${internalToken}` },
        body: JSON.stringify({
          ownerType: 'tenant',
          ownerId: userId,
          name: `gw-key-${stamp}`,
          scope: 'cloud_host',
          cloudHostId,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      });
      expect(minted.status).toBe(201);
      cloudHostKey = ((await minted.json()) as { secret: string }).secret;
    } catch (err) {
      await db.collection('cloudhosts').deleteOne({ _id: new mongoose.Types.ObjectId(cloudHostId) });
      throw err;
    }

    try {
      const listModels = async (key: string) => {
        const res = await fetch(`${HTTP}/v1/models`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        expect(res.status).toBe(200);
        return (await res.json()) as { data: Array<Record<string, unknown>> };
      };

      for (const key of [secret, cloudHostKey]) {
        const body = await listModels(key);
        const active = body.data.find((item) => item.id === withContext);
        expect(active?.context_length).toBe(200000);
        const unset = body.data.find((item) => item.id === withoutContext);
        expect(unset).toBeDefined();
        expect('context_length' in (unset as Record<string, unknown>)).toBe(false);
      }

      // 清空后立即消失（无缓存）
      await db.collection('models').updateOne(
        { providerId, name: withContext },
        { $set: { contextLength: null } },
      );
      for (const key of [secret, cloudHostKey]) {
        const body = await listModels(key);
        const cleared = body.data.find((item) => item.id === withContext);
        expect(cleared).toBeDefined();
        expect('context_length' in (cleared as Record<string, unknown>)).toBe(false);
      }
    } finally {
      await db.collection('billingapikeys').deleteMany({ cloudHostId: new mongoose.Types.ObjectId(cloudHostId) });
      await db.collection('cloudhosts').deleteOne({ _id: new mongoose.Types.ObjectId(cloudHostId) });
    }
  });

  it('T-B27: /v1/models 排除未定价 / 非计费（含全 0 价目档）模型', async () => {
    expect(process.env.MONGODB_URI, 'MONGODB_URI 必须注入，T-B27 不允许静默 skip').toBeTruthy();
    const db = (await mongoDb())!;
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
    expect(process.env.MONGODB_URI, 'MONGODB_URI 必须注入，T-B28 不允许静默 skip').toBeTruthy();
    const db = (await mongoDb())!;
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
describe('冻结账户网关口径（含未开启计费模型，MONGODB_URI 缺失即失败）', () => {
  it('T-B24: frozen 账户调用非计费模型同样 402 account_frozen', async () => {
    expect(process.env.MONGODB_URI, 'MONGODB_URI 必须注入，T-B24 不允许静默 skip').toBeTruthy();
    const db = (await mongoDb())!;
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
