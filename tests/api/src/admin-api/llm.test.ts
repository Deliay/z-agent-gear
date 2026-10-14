import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startMockServer, type MockServer } from '../mock-server.js';
import { adminGql, ensureAdminLogin } from './helpers.js';

const PROVIDERS = `
  query AdminProviders {
    adminProviders {
      id name type endpoint credentialType credentialValue isEnabled scope
      models { id name isEnabled sortOrder scope }
      createdAt updatedAt
    }
  }
`;

const MODELS = `
  query AdminModels {
    adminModels {
      id providerId provider { id name scope }
      name isCustom isEnabled sortOrder scope createdAt updatedAt
    }
  }
`;

const MODELS_BY_PROVIDER = `
  query AdminModelsByProvider($providerId: ID!) {
    adminModelsByProvider(providerId: $providerId) { id name isCustom isEnabled sortOrder scope }
  }
`;

const CREATE_PROVIDER = `
  mutation CreateGlobalProvider($input: ProviderInput!) {
    createGlobalProvider(input: $input) {
      id name type endpoint credentialType credentialValue isEnabled scope
      models { id name isEnabled sortOrder scope }
    }
  }
`;

const UPDATE_PROVIDER = `
  mutation UpdateGlobalProvider($id: ID!, $input: ProviderInput!) {
    updateGlobalProvider(id: $id, input: $input) { id name type isEnabled scope }
  }
`;

const DELETE_PROVIDER = `
  mutation DeleteGlobalProvider($id: ID!) { deleteGlobalProvider(id: $id) }
`;

const TOGGLE_PROVIDER = `
  mutation ToggleGlobalProvider($id: ID!) {
    toggleGlobalProvider(id: $id) { id isEnabled models { id isEnabled } }
  }
`;

const BATCH_ENABLE = `mutation($ids: [ID!]!) { batchEnableGlobalProviders(ids: $ids) { successCount } }`;
const BATCH_DISABLE = `mutation($ids: [ID!]!) { batchDisableGlobalProviders(ids: $ids) { successCount } }`;
const BATCH_DELETE = `mutation($ids: [ID!]!) { batchDeleteGlobalProviders(ids: $ids) { successCount } }`;

const CREATE_CUSTOM_MODEL = `
  mutation CreateGlobalCustomModel($input: CustomModelInput!) {
    createGlobalCustomModel(input: $input) { id providerId name isCustom isEnabled sortOrder scope }
  }
`;

const DELETE_CUSTOM_MODEL = `
  mutation DeleteGlobalCustomModel($id: ID!) { deleteGlobalCustomModel(id: $id) { id isCustom } }
`;

const TOGGLE_MODEL = `mutation($id: ID!) { toggleGlobalModel(id: $id) { id isEnabled } }`;

const UPDATE_MODEL_SORT = `mutation($ids: [ID!]!) { updateGlobalModelSortOrder(ids: $ids) { id sortOrder } }`;

describe('Admin Global LLM API', () => {
  let token = '';
  let mock: MockServer;

  beforeAll(async () => {
    mock = await startMockServer();
    token = await ensureAdminLogin();
  });

  afterAll(async () => {
    await mock?.close();
  });

  it('should reject adminProviders without auth', async () => {
    const body = await adminGql(PROVIDERS);
    expect(body.errors).toBeDefined();
    expect(body.errors![0].message).toBe('Not authenticated');
  });

  it('should reject business mutation without auth', async () => {
    const body = await adminGql(BATCH_ENABLE, { ids: [] });
    expect(body.errors).toBeDefined();
    expect(body.errors![0].message).toBe('Not authenticated');
  });

  it('should reject provider creation when connectivity test fails (T-P1)', async () => {
    const name = `global-bad-${Date.now()}`;
    const body = await adminGql(CREATE_PROVIDER, {
      input: {
        name,
        type: 'OpenAI',
        endpoint: 'http://127.0.0.1:1/v1',
        credentialType: 'api_key',
        credentialValue: 'sk-test-fake-key',
      },
    }, token);
    expect(body.errors).toBeDefined();
    // 真实失败形态（连接被拒）必须归一化为连通性文案，而非原始 SDK 报错
    expect(body.errors![0].message).toBe('供应商连通性测试失败，请检查 API 地址和凭据是否正确');

    const providers = await adminGql<{ adminProviders: Array<{ name: string }> }>(PROVIDERS, undefined, token);
    expect(providers.data!.adminProviders.some((p) => p.name === name)).toBe(false);
  });

  it('should create a global provider, sync global models and mask the credential (T-P2)', async () => {
    const name = `global-openai-${Date.now()}`;
    const body = await adminGql<{ createGlobalProvider: { id: string; credentialValue: string; scope: string; models: Array<{ scope: string; isEnabled: boolean }> } }>(
      CREATE_PROVIDER,
      {
        input: {
          name,
          type: 'OpenAI',
          endpoint: `http://127.0.0.1:${mock.port}/v1`,
          credentialType: 'api_key',
          credentialValue: 'sk-test-fake-key',
        },
      },
      token,
    );
    expect(body.errors).toBeUndefined();
    const provider = body.data!.createGlobalProvider;
    expect(provider.scope).toBe('global');
    expect(provider.credentialValue).toContain('****');
    expect(provider.credentialValue).not.toBe('sk-test-fake-key');
    expect(provider.models.length).toBeGreaterThan(0);
    expect(provider.models.every((m) => m.scope === 'global')).toBe(true);

    // 清理，避免污染其它套件（用户侧 models 空断言）
    await adminGql(DELETE_PROVIDER, { id: provider.id }, token);
  });

  it('should reject duplicate provider name within global scope (T-P7)', async () => {
    const name = `global-dup-${Date.now()}`;
    const input = {
      name,
      type: 'OpenAI',
      endpoint: `http://127.0.0.1:${mock.port}/v1`,
      credentialType: 'api_key',
      credentialValue: 'sk-key',
    };
    const first = await adminGql(CREATE_PROVIDER, { input }, token);
    expect(first.errors).toBeUndefined();
    const second = await adminGql(CREATE_PROVIDER, { input }, token);
    expect(second.errors).toBeDefined();
    expect(second.errors![0].message).toBe('Provider name already exists');
    await adminGql(DELETE_PROVIDER, { id: (first.data as { createGlobalProvider: { id: string } }).createGlobalProvider.id }, token);
  });

  it('should update provider preserving the credential when left empty (T-P3)', async () => {
    const name = `global-upd-${Date.now()}`;
    const created = await adminGql<{ createGlobalProvider: { id: string } }>(CREATE_PROVIDER, {
      input: {
        name,
        type: 'OpenAI',
        endpoint: `http://127.0.0.1:${mock.port}/v1`,
        credentialType: 'api_key',
        credentialValue: 'sk-test-fake-key',
      },
    }, token);
    const id = created.data!.createGlobalProvider.id;

    const updated = await adminGql<{ updateGlobalProvider: { name: string } }>(UPDATE_PROVIDER, {
      id,
      input: {
        name: `${name}-renamed`,
        type: 'OpenAI',
        endpoint: `http://127.0.0.1:${mock.port}/v1`,
        credentialType: 'api_key',
        credentialValue: '',
      },
    }, token);
    expect(updated.errors).toBeUndefined();
    expect(updated.data!.updateGlobalProvider.name).toBe(`${name}-renamed`);

    await adminGql(DELETE_PROVIDER, { id }, token);
  });

  it('should toggle provider and cascade to models (T-P5) and delete cascade (T-P4)', async () => {
    const name = `global-toggle-${Date.now()}`;
    const created = await adminGql<{ createGlobalProvider: { id: string } }>(CREATE_PROVIDER, {
      input: {
        name,
        type: 'OpenAI',
        endpoint: `http://127.0.0.1:${mock.port}/v1`,
        credentialType: 'api_key',
        credentialValue: 'sk-test-fake-key',
      },
    }, token);
    const id = created.data!.createGlobalProvider.id;

    const toggled = await adminGql<{ toggleGlobalProvider: { isEnabled: boolean; models: Array<{ isEnabled: boolean }> } }>(
      TOGGLE_PROVIDER, { id }, token,
    );
    expect(toggled.errors).toBeUndefined();
    expect(toggled.data!.toggleGlobalProvider.isEnabled).toBe(false);
    expect(toggled.data!.toggleGlobalProvider.models.every((m) => m.isEnabled === false)).toBe(true);

    const deleted = await adminGql<{ deleteGlobalProvider: boolean }>(DELETE_PROVIDER, { id }, token);
    expect(deleted.data!.deleteGlobalProvider).toBe(true);

    const models = await adminGql<{ adminModels: Array<{ providerId: string }> }>(MODELS, undefined, token);
    expect(models.data!.adminModels.some((m) => m.providerId === id)).toBe(false);
  });

  it('should handle batch operations on empty list', async () => {
    const enable = await adminGql<{ batchEnableGlobalProviders: { successCount: number } }>(BATCH_ENABLE, { ids: [] }, token);
    const disable = await adminGql<{ batchDisableGlobalProviders: { successCount: number } }>(BATCH_DISABLE, { ids: [] }, token);
    const del = await adminGql<{ batchDeleteGlobalProviders: { successCount: number } }>(BATCH_DELETE, { ids: [] }, token);
    expect(enable.data!.batchEnableGlobalProviders.successCount).toBe(0);
    expect(disable.data!.batchDisableGlobalProviders.successCount).toBe(0);
    expect(del.data!.batchDeleteGlobalProviders.successCount).toBe(0);
  });

  it('should create, list, toggle and delete a global custom model (T-M1/T-M2/T-M3)', async () => {
    const name = `global-models-${Date.now()}`;
    const created = await adminGql<{ createGlobalProvider: { id: string; models: Array<{ id: string; isCustom: boolean }> } }>(
      CREATE_PROVIDER,
      {
        input: {
          name,
          type: 'OpenAI',
          endpoint: `http://127.0.0.1:${mock.port}/v1`,
          credentialType: 'api_key',
          credentialValue: 'sk-test-fake-key',
        },
      },
      token,
    );
    const providerId = created.data!.createGlobalProvider.id;

    const custom = await adminGql<{ createGlobalCustomModel: { id: string; isCustom: boolean; scope: string } }>(
      CREATE_CUSTOM_MODEL,
      { input: { providerId, name: 'my-custom' } },
      token,
    );
    expect(custom.errors).toBeUndefined();
    expect(custom.data!.createGlobalCustomModel.isCustom).toBe(true);
    expect(custom.data!.createGlobalCustomModel.scope).toBe('global');

    const byProvider = await adminGql<{ adminModelsByProvider: Array<{ id: string; scope: string }> }>(
      MODELS_BY_PROVIDER, { providerId }, token,
    );
    expect(byProvider.data!.adminModelsByProvider.length).toBeGreaterThan(0);
    expect(byProvider.data!.adminModelsByProvider.every((m) => m.scope === 'global')).toBe(true);

    // 删除同步（非自定义）模型应被拒绝
    const synced = byProvider.data!.adminModelsByProvider.find((m) => m.id !== custom.data!.createGlobalCustomModel.id);
    if (synced) {
      const rejected = await adminGql(DELETE_CUSTOM_MODEL, { id: synced.id }, token);
      expect(rejected.errors).toBeDefined();
    }

    // 禁用供应商后 toggle 模型应被拒绝
    await adminGql(TOGGLE_PROVIDER, { id: providerId }, token);
    const toggleRejected = await adminGql(TOGGLE_MODEL, { id: custom.data!.createGlobalCustomModel.id }, token);
    expect(toggleRejected.errors).toBeDefined();

    await adminGql(TOGGLE_PROVIDER, { id: providerId }, token); // 恢复启用
    const deleted = await adminGql<{ deleteGlobalCustomModel: { id: string } }>(
      DELETE_CUSTOM_MODEL, { id: custom.data!.createGlobalCustomModel.id }, token,
    );
    expect(deleted.data!.deleteGlobalCustomModel.id).toBe(custom.data!.createGlobalCustomModel.id);

    await adminGql(DELETE_PROVIDER, { id: providerId }, token);
  });

  it('should persist model sort order (T-M4)', async () => {
    const name = `global-sort-${Date.now()}`;
    const created = await adminGql<{ createGlobalProvider: { id: string; models: Array<{ id: string }> } }>(
      CREATE_PROVIDER,
      {
        input: {
          name,
          type: 'OpenAI',
          endpoint: `http://127.0.0.1:${mock.port}/v1`,
          credentialType: 'api_key',
          credentialValue: 'sk-test-fake-key',
        },
      },
      token,
    );
    const ids = created.data!.createGlobalProvider.models.map((m) => m.id).slice(0, 3);
    const reversed = [...ids].reverse();
    const body = await adminGql<{ updateGlobalModelSortOrder: Array<{ id: string; sortOrder: number }> }>(
      UPDATE_MODEL_SORT, { ids: reversed }, token,
    );
    expect(body.errors).toBeUndefined();
    const ordered = body.data!.updateGlobalModelSortOrder;
    expect(ordered[0].id).toBe(reversed[0]);

    await adminGql(DELETE_PROVIDER, { id: created.data!.createGlobalProvider.id }, token);
  });

  it('scope isolation: admin never sees user-scope providers/models (T-SC5 反向)', async () => {
    const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
    const username = `iso${Date.now().toString(36).slice(-8)}${Math.random().toString(36).slice(2, 5)}`;

    const signup = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'mutation($u:String!,$p:String!){signup(username:$u,password:$p){token}}',
        variables: { u: username, p: 'testpass123' },
      }),
    }).then((r) => r.json() as Promise<{ data?: { signup?: { token?: string } } }>);
    const userToken = signup.data!.signup!.token!;

    const userProviderName = `user-iso-${Date.now()}`;
    const created = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        query: `mutation($input: ProviderInput!) {
          createProvider(input: $input) { id name models { id } }
        }`,
        variables: {
          input: {
            name: userProviderName,
            type: 'OpenAI',
            endpoint: `http://127.0.0.1:${mock.port}/v1`,
            credentialType: 'api_key',
            credentialValue: 'sk-user-key',
          },
        },
      }),
    }).then((r) => r.json() as Promise<{ data?: { createProvider?: { id: string; models: Array<{ id: string }> } } }>);
    const userProviderId = created.data!.createProvider!.id;
    const userModelId = created.data!.createProvider!.models[0]?.id;

    try {
      const providers = await adminGql<{ adminProviders: Array<{ id: string; name: string }> }>(PROVIDERS, undefined, token);
      expect(providers.data!.adminProviders.some((p) => p.id === userProviderId || p.name === userProviderName)).toBe(false);

      const models = await adminGql<{ adminModels: Array<{ id: string; providerId: string }> }>(MODELS, undefined, token);
      expect(models.data!.adminModels.some((m) => m.providerId === userProviderId)).toBe(false);
      if (userModelId) {
        expect(models.data!.adminModels.some((m) => m.id === userModelId)).toBe(false);
      }

      // admin 的删除受 scope 过滤，删不掉用户侧供应商
      const denied = await adminGql<{ deleteGlobalProvider: boolean }>(DELETE_PROVIDER, { id: userProviderId }, token);
      expect(denied.data?.deleteGlobalProvider).toBe(false);
    } finally {
      // 用户自清（无论断言成败都执行）
      await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
        body: JSON.stringify({ query: 'mutation($id:ID!){deleteProvider(id:$id)}', variables: { id: userProviderId } }),
      });
    }
  });
});
