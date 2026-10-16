import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { startMockServer, type MockServer } from '../mock-server.js';
import { adminGql, ensureAdminLogin } from '../admin-api/helpers.js';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const ADMIN_API_URL = process.env.ADMIN_API_URL || 'http://localhost:10003/graphql';

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
}

let authToken = '';
let providerId = '';

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) {
      token
      user { id username }
    }
  }
`;

const PROVIDERS_QUERY = `
  query Providers {
    providers {
      id name type endpoint credentialType credentialValue isEnabled scope
      models { id name isEnabled sortOrder scope }
      createdAt updatedAt
    }
  }
`;

const MODELS_QUERY = `
  query Models {
    models {
      id providerId provider { id name type isEnabled scope }
      name isCustom isEnabled sortOrder scope createdAt updatedAt
    }
  }
`;

const MODELS_BY_PROVIDER = `
  query ModelsByProvider($providerId: ID!) {
    modelsByProvider(providerId: $providerId) {
      id name isCustom isEnabled sortOrder
    }
  }
`;

const CREATE_PROVIDER = `
  mutation CreateProvider($input: ProviderInput!) {
    createProvider(input: $input) {
      id name type endpoint credentialType credentialValue isEnabled
      models { id name isEnabled sortOrder }
      createdAt updatedAt
    }
  }
`;

const UPDATE_PROVIDER = `
  mutation UpdateProvider($id: ID!, $input: ProviderInput!) {
    updateProvider(id: $id, input: $input) {
      id name type isEnabled
    }
  }
`;

const DELETE_PROVIDER = `
  mutation DeleteProvider($id: ID!) {
    deleteProvider(id: $id)
  }
`;

const TOGGLE_PROVIDER = `
  mutation ToggleProvider($id: ID!) {
    toggleProvider(id: $id) {
      id isEnabled
      models { id isEnabled }
    }
  }
`;

const BATCH_ENABLE = `
  mutation BatchEnableProviders($ids: [ID!]!) {
    batchEnableProviders(ids: $ids) { successCount }
  }
`;

const BATCH_DISABLE = `
  mutation BatchDisableProviders($ids: [ID!]!) {
    batchDisableProviders(ids: $ids) { successCount }
  }
`;

const BATCH_DELETE = `
  mutation BatchDeleteProviders($ids: [ID!]!) {
    batchDeleteProviders(ids: $ids) { successCount }
  }
`;

const DELETE_CUSTOM_MODEL = `
  mutation DeleteCustomModel($id: ID!) {
    deleteCustomModel(id: $id) { id isCustom }
  }
`;

const CREATE_CUSTOM_MODEL = `
  mutation CreateCustomModel($input: CustomModelInput!) {
    createCustomModel(input: $input) {
      id providerId name isCustom isEnabled sortOrder
    }
  }
`;

const TOGGLE_MODEL = `
  mutation ToggleModel($id: ID!) {
    toggleModel(id: $id) { id isEnabled }
  }
`;

const UPDATE_MODEL_SORT = `
  mutation UpdateModelSortOrder($ids: [ID!]!) {
    updateModelSortOrder(ids: $ids) { id sortOrder }
  }
`;

describe('LLM Provider & Model API', () => {
  let mock: MockServer;
  let seededProviderId = '';

  beforeAll(async () => {
    mock = await startMockServer();

    const uid = `llm_${Date.now()}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token ?? '';
    expect(authToken).toBeDefined();

    // 保证后续 providers/models 列表非空：先创建一个用户侧供应商（mock 会同步出模型）。
    // 若断言仅用 every(...) 且数组为空，则恒真、失去回归检测力（见验收问题 17）。
    const createRes = await gqlRequest(
      CREATE_PROVIDER,
      {
        input: {
          name: `scope-seed-provider-${Date.now()}`,
          type: 'OpenAI',
          endpoint: `http://127.0.0.1:${mock.port}/v1`,
          credentialType: 'api_key',
          credentialValue: 'sk-test-fake-key',
        },
      },
      authToken,
    );
    const created = await createRes.json();
    seededProviderId = created.data?.createProvider?.id ?? '';
    expect(seededProviderId).toBeTruthy();
  });

  afterAll(async () => {
    await mock?.close();
  });

  describe('queries without auth', () => {
    it('should reject providers query without token', async () => {
      const res = await gqlRequest(PROVIDERS_QUERY);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject models query without token', async () => {
      const res = await gqlRequest(MODELS_QUERY);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('queries with auth', () => {
    it('should return only user-scope providers (non-empty)', async () => {
      const res = await gqlRequest(PROVIDERS_QUERY, undefined, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(Array.isArray(body.data.providers)).toBe(true);
      // 先断言非空（beforeAll 已创建用户侧供应商），再验证过滤条件，避免空数组 every(...) 恒真
      expect(body.data.providers.length).toBeGreaterThan(0);
      expect(body.data.providers.some((p: { id: string }) => p.id === seededProviderId)).toBe(true);
      // 全局（scope=global）供应商不展示在用户侧
      expect(body.data.providers.every((p: { scope: string }) => p.scope === 'user')).toBe(true);
    });

    it('should return a non-empty models array (user models + enabled global models)', async () => {
      const res = await gqlRequest(MODELS_QUERY, undefined, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(Array.isArray(body.data.models)).toBe(true);
      // 先断言非空（用户侧供应商已同步出模型），再验证过滤条件
      expect(body.data.models.length).toBeGreaterThan(0);
      expect(
        body.data.models.some((m: { providerId: string }) => m.providerId === seededProviderId),
      ).toBe(true);
      // 全局模型必须处于启用态才会出现在用户侧
      expect(
        body.data.models.every((m: { scope: string; isEnabled: boolean }) => m.scope !== 'global' || m.isEnabled),
      ).toBe(true);
    });
  });

  describe('createProvider', () => {
    it('should reject invalid endpoint (connectivity test fails)', async () => {
      const name = `test-provider-${Date.now()}`;
      const res = await gqlRequest(
        CREATE_PROVIDER,
        {
          input: {
            name,
            type: 'OpenAI',
            endpoint: 'http://127.0.0.1:1/v1',
            credentialType: 'api_key',
            credentialValue: 'sk-test-fake-key',
          },
        },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBeTruthy();
      const providersRes = await gqlRequest(PROVIDERS_QUERY, undefined, authToken);
      const providersBody = await providersRes.json();
      expect(providersBody.data.providers.some((p: { name: string }) => p.name === name)).toBe(false);
    });

    it('should reject empty name', async () => {
      const res = await gqlRequest(
        CREATE_PROVIDER,
        {
          input: {
            name: '',
            type: 'OpenAI',
            endpoint: `http://127.0.0.1:${mock.port}/v1`,
            credentialType: 'api_key',
            credentialValue: 'sk-test-key',
          },
        },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
    });

    it('should reject mutation without auth', async () => {
      const res = await gqlRequest(CREATE_PROVIDER, {
        input: {
          name: 'no-auth',
          type: 'OpenAI',
          endpoint: `http://127.0.0.1:${mock.port}/v1`,
          credentialType: 'api_key',
          credentialValue: 'sk-key',
        },
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('batch operations without existing providers', () => {
    it('should handle batchEnable on empty list', async () => {
      const res = await gqlRequest(BATCH_ENABLE, { ids: [] }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.batchEnableProviders.successCount).toBe(0);
    });

    it('should handle batchDisable on empty list', async () => {
      const res = await gqlRequest(BATCH_DISABLE, { ids: [] }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.batchDisableProviders.successCount).toBe(0);
    });

    it('should handle batchDelete on empty list', async () => {
      const res = await gqlRequest(BATCH_DELETE, { ids: [] }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.batchDeleteProviders.successCount).toBe(0);
    });

    it('should reject batch operations without auth', async () => {
      const res = await gqlRequest(BATCH_ENABLE, { ids: ['fake-id'] });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('toggleProvider', () => {
    it('should reject toggling non-existent provider', async () => {
      const res = await gqlRequest(TOGGLE_PROVIDER, { id: '000000000000000000000000' }, authToken);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Provider not found');
    });

    it('should reject toggle without auth', async () => {
      const res = await gqlRequest(TOGGLE_PROVIDER, { id: 'fake-id' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('deleteProvider', () => {
    it('should return false for non-existent provider', async () => {
      const res = await gqlRequest(DELETE_PROVIDER, { id: '000000000000000000000000' }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.deleteProvider).toBe(false);
    });
  });

  describe('updateProvider', () => {
    it('should reject updating non-existent provider', async () => {
      const res = await gqlRequest(
        UPDATE_PROVIDER,
        {
          id: '000000000000000000000000',
          input: {
            name: 'updated',
            type: 'OpenAI',
            endpoint: `http://127.0.0.1:${mock.port}/v1`,
            credentialType: 'api_key',
            credentialValue: 'sk-updated-key',
          },
        },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBeTruthy();
    });
  });

  describe('custom model mutations', () => {
    it('should reject createCustomModel without auth', async () => {
      const res = await gqlRequest(CREATE_CUSTOM_MODEL, {
        input: { providerId: 'fake', name: 'test-model' },
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject deleteCustomModel without auth', async () => {
      const res = await gqlRequest(DELETE_CUSTOM_MODEL, { id: 'fake' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject deleteCustomModel for non-existent model', async () => {
      const res = await gqlRequest(DELETE_CUSTOM_MODEL, { id: '000000000000000000000000' }, authToken);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Model not found or is not a custom model');
    });

    it('should reject toggleModel without auth', async () => {
      const res = await gqlRequest(TOGGLE_MODEL, { id: 'fake' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject updateModelSortOrder without auth', async () => {
      const res = await gqlRequest(UPDATE_MODEL_SORT, { ids: ['fake1', 'fake2'] });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  // #3: updateProvider with empty credentialValue should preserve existing key
  describe('updateProvider with empty credentialValue', () => {
    it('should update without changing credentialValue (empty credentialValue preserves existing)', async () => {
      const mockEndpoint = `http://127.0.0.1:${mock.port}/v1`;
      const name = `crud-provider-${Date.now()}`;
      const createRes = await gqlRequest(
        CREATE_PROVIDER,
        {
          input: {
            name,
            type: 'OpenAI',
            endpoint: mockEndpoint,
            credentialType: 'api_key',
            credentialValue: 'sk-test-fake-key',
          },
        },
        authToken,
      );
      const created = await createRes.json();
      expect(created.errors).toBeUndefined();
      const pid = created.data.createProvider.id;

      // Update with empty credentialValue — should preserve existing
      const updateRes = await gqlRequest(
        UPDATE_PROVIDER,
        {
          id: pid,
          input: {
            name: `${name}-renamed`,
            type: 'OpenAI',
            endpoint: mockEndpoint,
            credentialType: 'api_key',
            credentialValue: '',
          },
        },
        authToken,
      );
      const updated = await updateRes.json();
      expect(updated.errors).toBeUndefined();
      expect(updated.data.updateProvider.name).toBe(`${name}-renamed`);

      // Cleanup
      await gqlRequest(DELETE_PROVIDER, { id: pid }, authToken);
    });
  });

  // #2: Models should be returned after provider creation
  describe('model lifecycle after provider CRUD', () => {
    let pid = '';

    it('should create provider and its models appear in models query', async () => {
      const mockEndpoint = `http://127.0.0.1:${mock.port}/v1`;
      const name = `lifecycle-provider-${Date.now()}`;
      const createRes = await gqlRequest(
        CREATE_PROVIDER,
        {
          input: {
            name,
            type: 'OpenAI',
            endpoint: mockEndpoint,
            credentialType: 'api_key',
            credentialValue: 'sk-test-fake-key',
          },
        },
        authToken,
      );
      const created = await createRes.json();
      expect(created.errors).toBeUndefined();
      pid = created.data.createProvider.id;
      expect(created.data.createProvider.models.length).toBeGreaterThan(0);

      // Verify models query also returns them
      const modelsRes = await gqlRequest(MODELS_QUERY, undefined, authToken);
      const modelsBody = await modelsRes.json();
      expect(modelsBody.errors).toBeUndefined();
      const providerModels = modelsBody.data.models.filter(
        (m: { providerId: string }) => m.providerId === pid,
      );
      expect(providerModels.length).toBeGreaterThan(0);
    });

    // #6: Delete provider should cascade-delete its models
    it('should delete provider and cascade-delete its models', async () => {
      expect(pid).toBeTruthy();

      const delRes = await gqlRequest(DELETE_PROVIDER, { id: pid }, authToken);
      const delBody = await delRes.json();
      expect(delBody.errors).toBeUndefined();
      expect(delBody.data.deleteProvider).toBe(true);

      const modelsRes = await gqlRequest(MODELS_QUERY, undefined, authToken);
      const modelsBody = await modelsRes.json();
      const remaining = modelsBody.data.models.filter(
        (m: { providerId: string }) => m.providerId === pid,
      );
      expect(remaining.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// T-SC*: agent-api scope 回归 —— 管理后台全局配置对用户生效、用户不可写全局数据
// ---------------------------------------------------------------------------
describe('Agent API scope regression (global config from admin backend)', () => {
  let mock: MockServer;
  let authToken = '';
  let adminToken = '';
  let globalProviderId = '';
  let globalModelId = '';

  const CREATE_GLOBAL_PROVIDER = `
    mutation CreateGlobalProvider($input: ProviderInput!) {
      createGlobalProvider(input: $input) {
        id scope
        models { id name scope isEnabled }
      }
    }
  `;
  const DELETE_GLOBAL_PROVIDER = `mutation($id: ID!) { deleteGlobalProvider(id: $id) }`;
  const TOGGLE_GLOBAL_PROVIDER = `mutation($id: ID!) { toggleGlobalProvider(id: $id) { id isEnabled } }`;

  beforeAll(async () => {
    mock = await startMockServer();

    const uid = `scope_${Date.now()}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token ?? '';
    expect(authToken).toBeTruthy();

    adminToken = await ensureAdminLogin();

    const created = await adminGql<{ createGlobalProvider: { id: string; scope: string; models: Array<{ id: string; scope: string; isEnabled: boolean }> } }>(
      CREATE_GLOBAL_PROVIDER,
      {
        input: {
          name: `agent-scope-global-${Date.now()}`,
          type: 'OpenAI',
          endpoint: `http://127.0.0.1:${mock.port}/v1`,
          credentialType: 'api_key',
          credentialValue: 'sk-test-fake-key',
        },
      },
      adminToken,
    );
    expect(created.errors).toBeUndefined();
    globalProviderId = created.data!.createGlobalProvider.id;
    globalModelId = created.data!.createGlobalProvider.models[0].id;
  });

  afterAll(async () => {
    if (globalProviderId) {
      await adminGql(DELETE_GLOBAL_PROVIDER, { id: globalProviderId }, adminToken);
    }
    await mock?.close();
  });

  it('should include enabled global models in the user models query (T-SC1)', async () => {
    const res = await gqlRequest(MODELS_QUERY, undefined, authToken);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    const found = body.data.models.find((m: { id: string }) => m.id === globalModelId);
    expect(found).toBeDefined();
    expect(found.scope).toBe('global');
  });

  it('should not expose global providers in the user providers query (T-SC5)', async () => {
    const res = await gqlRequest(PROVIDERS_QUERY, undefined, authToken);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.providers.some((p: { id: string }) => p.id === globalProviderId)).toBe(false);
  });

  it('should expose only a credential-free provider summary via Model.provider (T-SC5)', async () => {
    const res = await gqlRequest(MODELS_QUERY, undefined, authToken);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    const found = body.data.models.find((m: { id: string }) => m.id === globalModelId);
    expect(found).toBeDefined();
    expect(found.provider).toBeDefined();
    expect(found.provider.scope).toBe('global');
    // 摘要仅暴露非敏感字段，不含 endpoint / credentialType / credentialValue
    expect(Object.keys(found.provider).sort()).toEqual(['id', 'isEnabled', 'name', 'scope', 'type']);
  });

  it('should reject queries for provider endpoint/credential via Model.provider (T-SC5)', async () => {
    const res = await gqlRequest(
      `query { models { id provider { id endpoint credentialValue } } }`,
      undefined,
      authToken,
    );
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain('endpoint');
  });

  it('should allow same provider name across user and global scopes (T-SC7)', async () => {
    // 读取全局供应商名称，用同名创建用户侧供应商
    const gql = await fetch(ADMIN_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ query: `query { adminProviders { id name } }` }),
    });
    const gqlBody = await gql.json();
    const globalName = gqlBody.data.adminProviders.find((p: { id: string }) => p.id === globalProviderId).name;

    const res = await gqlRequest(CREATE_PROVIDER, {
      input: {
        name: globalName,
        type: 'OpenAI',
        endpoint: `http://127.0.0.1:${mock.port}/v1`,
        credentialType: 'api_key',
        credentialValue: 'sk-test-fake-key',
      },
    }, authToken);
    const body = await res.json();
    expect(body.errors).toBeUndefined();

    await gqlRequest(DELETE_PROVIDER, { id: body.data.createProvider.id }, authToken);
  });

  it('should reject user writes to a global model (T-SC3)', async () => {
    const res = await gqlRequest(TOGGLE_MODEL, { id: globalModelId }, authToken);
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain('全局配置请在管理后台修改');
  });

  it('should reject user writes to a global provider (T-SC4)', async () => {
    const toggleRes = await gqlRequest(TOGGLE_PROVIDER, { id: globalProviderId }, authToken);
    const toggleBody = await toggleRes.json();
    expect(toggleBody.errors).toBeDefined();
    expect(toggleBody.errors[0].message).toContain('全局配置请在管理后台修改');

    const delRes = await gqlRequest(DELETE_PROVIDER, { id: globalProviderId }, authToken);
    const delBody = await delRes.json();
    expect(delBody.errors).toBeDefined();
    expect(delBody.errors[0].message).toContain('全局配置请在管理后台修改');
  });

  it('should stop returning a global model once the admin disables it (T-SC1)', async () => {
    // 通过 admin 禁用整个全局供应商（级联禁用其模型）
    await adminGql(TOGGLE_GLOBAL_PROVIDER, { id: globalProviderId }, adminToken);

    const res = await gqlRequest(MODELS_QUERY, undefined, authToken);
    const body = await res.json();
    expect(body.data.models.some((m: { id: string }) => m.id === globalModelId)).toBe(false);

    // 恢复启用，避免影响后续（afterAll 会删除）
    await adminGql(TOGGLE_GLOBAL_PROVIDER, { id: globalProviderId }, adminToken);
  });
});

// ---------------------------------------------------------------------------
// 回归：重同步同名冲突（问题 48）与悬空 providerId（问题 51）
// 需直接操纵共享 Mongo 构造边界数据，故依赖 MONGODB_URI；缺失时显式跳过。
// ---------------------------------------------------------------------------
describe('LLM resync & dangling provider regressions', () => {
  let mock: MockServer;
  let token = '';

  async function modelsCollection() {
    const uri = process.env.MONGODB_URI as string;
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(uri);
    }
    const db = mongoose.connection.db;
    if (!db) throw new Error('Mongo connection unavailable');
    return db.collection('models');
  }

  beforeAll(async () => {
    mock = await startMockServer();
    const uid = `llmreg_${Date.now()}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    token = body.data?.signup?.token ?? '';
    expect(token).toBeTruthy();
  });

  afterAll(async () => {
    await mock?.close();
  });

  it.skipIf(!process.env.MONGODB_URI)(
    'preserves a custom model that shares its name with a fetched API model on resync (issue 48)',
    async () => {
      const endpoint = `http://127.0.0.1:${mock.port}/v1`;
      const name = `resync-provider-${Date.now()}`;
      const created = await (
        await gqlRequest(
          CREATE_PROVIDER,
          {
            input: { name, type: 'OpenAI', endpoint, credentialType: 'api_key', credentialValue: 'sk-test-fake-key' },
          },
          token,
        )
      ).json();
      expect(created.errors).toBeUndefined();
      const pid = created.data.createProvider.id as string;

      const models = await modelsCollection();
      const providerOid = new mongoose.Types.ObjectId(pid);
      try {
        // 把已同步的 gpt-4o 改造成「自定义模型」，制造与 API 同名冲突
        const marked = await models.updateOne(
          { providerId: providerOid, name: 'gpt-4o' },
          { $set: { isCustom: true } },
        );
        expect(marked.matchedCount).toBe(1);

        // 改凭据触发重同步：远端仍返回 gpt-4o（与自定义同名）
        const updated = await (
          await gqlRequest(
            UPDATE_PROVIDER,
            {
              id: pid,
              input: { name, type: 'OpenAI', endpoint, credentialType: 'api_key', credentialValue: 'sk-resync-key' },
            },
            token,
          )
        ).json();
        // 修复前此处会因 (providerId,name) 唯一键冲突 E11000 报错，且同步模型全丢
        expect(updated.errors).toBeUndefined();

        const list = await (
          await gqlRequest(MODELS_BY_PROVIDER, { providerId: pid }, token)
        ).json();
        expect(list.errors).toBeUndefined();
        const byName = new Map<string, { isCustom: boolean }>(
          (list.data.modelsByProvider as Array<{ name: string; isCustom: boolean }>).map((m) => [m.name, m]),
        );
        // 同名自定义模型存活
        expect(byName.get('gpt-4o')?.isCustom).toBe(true);
        // 其余 API 模型完成重同步，未整表丢失
        expect(byName.has('gpt-4o-mini')).toBe(true);
        expect(byName.has('gpt-4-turbo')).toBe(true);
      } finally {
        await models.deleteMany({ providerId: providerOid });
        await gqlRequest(DELETE_PROVIDER, { id: pid }, token);
      }
    },
  );

  it.skipIf(!process.env.MONGODB_URI)(
    'returns provider: null (query still succeeds) for a model whose provider no longer exists (issue 51)',
    async () => {
      const endpoint = `http://127.0.0.1:${mock.port}/v1`;
      const name = `dangling-provider-${Date.now()}`;
      const created = await (
        await gqlRequest(
          CREATE_PROVIDER,
          {
            input: { name, type: 'OpenAI', endpoint, credentialType: 'api_key', credentialValue: 'sk-test-fake-key' },
          },
          token,
        )
      ).json();
      expect(created.errors).toBeUndefined();
      const pid = created.data.createProvider.id as string;

      const list = await (
        await gqlRequest(MODELS_BY_PROVIDER, { providerId: pid }, token)
      ).json();
      const modelId = list.data.modelsByProvider[0].id as string;

      const models = await modelsCollection();
      const modelOid = new mongoose.Types.ObjectId(modelId);
      try {
        // providerId 指向一个不存在的供应商，制造悬空引用
        await models.updateOne(
          { _id: modelOid },
          { $set: { providerId: new mongoose.Types.ObjectId() } },
        );

        const res = await gqlRequest(MODELS_QUERY, undefined, token);
        const body = await res.json();
        expect(body.errors).toBeUndefined();
        const found = body.data.models.find((m: { id: string }) => m.id === modelId);
        expect(found).toBeDefined();
        expect(found.provider).toBeNull();
      } finally {
        await models.deleteOne({ _id: modelOid });
        await gqlRequest(DELETE_PROVIDER, { id: pid }, token);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 回归：create 对上游重复模型名去重（问题 54）
// 需真实 Mongo 验证 (providerId,name) 唯一索引不再被重复名触发；缺失时显式跳过。
// ---------------------------------------------------------------------------
describe('LLM create dedupe regression (issue 54)', () => {
  let token = '';

  beforeAll(async () => {
    const uid = `ld_${Date.now().toString(36)}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    token = body.data?.signup?.token ?? '';
    expect(token).toBeTruthy();
  });

  it.skipIf(!process.env.MONGODB_URI)(
    'creates a provider and dedupes duplicate upstream model names (no E11000)',
    async () => {
      // 上游（网关/代理）返回重复模型名：修复前 create 直接 insertMany → (providerId,name)
      // 唯一索引 E11000，供应商已落库成为孤儿且请求报错。
      const dupServer = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: ['dup-model-a', 'dup-model-a', 'dup-model-b', 'dup-model-a'].map((id) => ({
              id,
              object: 'model',
              created: 0,
              owned_by: 'mock',
            })),
          }),
        );
      });
      await new Promise<void>((resolve) => dupServer.listen(0, '127.0.0.1', resolve));
      const addr = dupServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      let pid = '';
      try {
        const name = `dup-provider-${Date.now()}`;
        const created = await (
          await gqlRequest(
            CREATE_PROVIDER,
            {
              input: {
                name,
                type: 'OpenAI',
                endpoint: `http://127.0.0.1:${port}/v1`,
                credentialType: 'api_key',
                credentialValue: 'sk-test-fake-key',
              },
            },
            token,
          )
        ).json();
        expect(created.errors).toBeUndefined();
        pid = created.data.createProvider.id as string;
        expect(pid).toBeTruthy();

        const list = await (
          await gqlRequest(MODELS_BY_PROVIDER, { providerId: pid }, token)
        ).json();
        expect(list.errors).toBeUndefined();
        const names = (list.data.modelsByProvider as Array<{ name: string }>).map((m) => m.name);
        // 去重且保留首次出现顺序
        expect(names).toEqual(['dup-model-a', 'dup-model-b']);
        expect(new Set(names).size).toBe(names.length);
      } finally {
        if (pid) await gqlRequest(DELETE_PROVIDER, { id: pid }, token);
        await new Promise<void>((resolve) => dupServer.close(() => resolve()));
      }
    },
  );
});
