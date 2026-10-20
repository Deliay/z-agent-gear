import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
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

const LIST_PROVIDER_MODELS = `
  query ListGlobalProviderModels($providerId: ID!) {
    listGlobalProviderModels(providerId: $providerId) { name isImported isDuplicate }
  }
`;

const IMPORT_MODELS = `
  mutation ImportGlobalModels($providerId: ID!, $names: [String!]!) {
    importGlobalModels(providerId: $providerId, names: $names) { id providerId name isCustom scope }
  }
`;

const RENAME_RECORDS = `
  query ModelRenameRecords {
    modelRenameRecords { id modelId providerId providerName oldName newName batchId renamedAt }
  }
`;

const DELETE_MODEL = `
  mutation DeleteGlobalModel($id: ID!) { deleteGlobalModel(id: $id) { id isCustom } }
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

  it('should create a global provider without importing models and mask the credential (T-P2)', async () => {
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
    // 后台改为手动导入：创建供应商不再自动写入模型
    expect(provider.models).toEqual([]);
    const models = await adminGql<{ adminModelsByProvider: Array<{ id: string }> }>(
      MODELS_BY_PROVIDER, { providerId: provider.id }, token,
    );
    expect(models.data!.adminModelsByProvider).toEqual([]);

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
    expect(byProvider.data!.adminModelsByProvider).toHaveLength(1);
    expect(byProvider.data!.adminModelsByProvider[0].scope).toBe('global');

    // 禁用供应商后 toggle 模型应被拒绝
    await adminGql(TOGGLE_PROVIDER, { id: providerId }, token);
    const toggleRejected = await adminGql(TOGGLE_MODEL, { id: custom.data!.createGlobalCustomModel.id }, token);
    expect(toggleRejected.errors).toBeDefined();

    await adminGql(TOGGLE_PROVIDER, { id: providerId }, token); // 恢复启用
    const deleted = await adminGql<{ deleteGlobalModel: { id: string } }>(
      DELETE_MODEL, { id: custom.data!.createGlobalCustomModel.id }, token,
    );
    expect(deleted.data!.deleteGlobalModel.id).toBe(custom.data!.createGlobalCustomModel.id);

    await adminGql(DELETE_PROVIDER, { id: providerId }, token);
  });


  it('T-P2b: updating a provider no longer resyncs models', async () => {
    const name = `global-upd-nosync-${Date.now()}`;
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
    const before = await adminGql<{ adminModelsByProvider: Array<{ id: string }> }>(
      MODELS_BY_PROVIDER, { providerId: id }, token,
    );
    expect(before.data!.adminModelsByProvider).toEqual([]);

    const updated = await adminGql(UPDATE_PROVIDER, {
      id,
      input: {
        name: `${name}-renamed`,
        type: 'OpenAI',
        endpoint: `http://127.0.0.1:${mock.port}/v1?changed=1`,
        credentialType: 'api_key',
        credentialValue: '',
      },
    }, token);
    expect(updated.errors).toBeUndefined();

    const after = await adminGql<{ adminModelsByProvider: Array<{ id: string }> }>(
      MODELS_BY_PROVIDER, { providerId: id }, token,
    );
    expect(after.data!.adminModelsByProvider).toEqual([]);
    await adminGql(DELETE_PROVIDER, { id }, token);
  });

  it.skipIf(!process.env.MONGODB_URI)('T-MR1/T-MR2: the rename ledger matches actual renames and survives deletion', async () => {
    const uri = process.env.MONGODB_URI!;
    if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
    const db = mongoose.connection.db!;

    const records = await adminGql<{ modelRenameRecords: Array<{ id: string; modelId: string; oldName: string; newName: string; providerName: string; batchId: string; renamedAt: string }> }>(
      RENAME_RECORDS, undefined, token,
    );
    expect(records.errors).toBeUndefined();
    const list = records.data!.modelRenameRecords;
    expect(list.every((r) => r.batchId === '20261020-005')).toBe(true);
    for (const record of list) {
      const doc = await db.collection('models').findOne({ _id: new mongoose.Types.ObjectId(record.modelId) });
      if (doc) {
        // 未删除的模型仍以 newName 存在
        expect(doc.name).toBe(record.newName);
      }
      expect(new Date(record.renamedAt).toString()).not.toBe('Invalid Date');
    }
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
    const providerId = created.data!.createGlobalProvider.id;
    const ids: string[] = [];
    for (const name of ['sort-a', 'sort-b', 'sort-c']) {
      const made = await adminGql<{ createGlobalCustomModel: { id: string } }>(
        CREATE_CUSTOM_MODEL, { input: { providerId, name: `${name}-${Date.now()}` } }, token,
      );
      ids.push(made.data!.createGlobalCustomModel.id);
    }
    const reversed = [...ids].reverse();
    const body = await adminGql<{ updateGlobalModelSortOrder: Array<{ id: string; sortOrder: number }> }>(
      UPDATE_MODEL_SORT, { ids: reversed }, token,
    );
    expect(body.errors).toBeUndefined();
    const ordered = body.data!.updateGlobalModelSortOrder;
    expect(ordered[0].id).toBe(reversed[0]);

    await adminGql(DELETE_PROVIDER, { id: created.data!.createGlobalProvider.id }, token);
  });

  it('T-MI1/T-MI2/T-MI3: lists upstream models, imports selected names and is idempotent', async () => {
    const created = await adminGql<{ createGlobalProvider: { id: string } }>(CREATE_PROVIDER, {
      input: {
        name: `global-import-${Date.now()}`,
        type: 'OpenAI',
        endpoint: `http://127.0.0.1:${mock.port}/v1`,
        credentialType: 'api_key',
        credentialValue: 'sk-test-fake-key',
      },
    }, token);
    const providerId = created.data!.createGlobalProvider.id;

    try {
      const listed = await adminGql<{ listGlobalProviderModels: Array<{ name: string; isImported: boolean; isDuplicate: boolean }> }>(
        LIST_PROVIDER_MODELS, { providerId }, token,
      );
      expect(listed.errors).toBeUndefined();
      expect(listed.data!.listGlobalProviderModels.map((m) => m.name)).toEqual(
        expect.arrayContaining(['gpt-4o', 'gpt-4o-mini']),
      );
      expect(listed.data!.listGlobalProviderModels.every((m) => !m.isImported && !m.isDuplicate)).toBe(true);

      const imported = await adminGql<{ importGlobalModels: Array<{ id: string; name: string; isCustom: boolean; scope: string }> }>(
        IMPORT_MODELS, { providerId, names: ['gpt-4o', 'gpt-4o-mini'] }, token,
      );
      expect(imported.errors).toBeUndefined();
      expect(imported.data!.importGlobalModels.map((m) => m.name).sort()).toEqual(['gpt-4o', 'gpt-4o-mini']);
      expect(imported.data!.importGlobalModels.every((m) => !m.isCustom && m.scope === 'global')).toBe(true);

      const relisted = await adminGql<{ listGlobalProviderModels: Array<{ name: string; isImported: boolean }> }>(
        LIST_PROVIDER_MODELS, { providerId }, token,
      );
      expect(relisted.data!.listGlobalProviderModels.find((m) => m.name === 'gpt-4o')!.isImported).toBe(true);

      const again = await adminGql<{ importGlobalModels: Array<{ id: string }> }>(
        IMPORT_MODELS, { providerId, names: ['gpt-4o'] }, token,
      );
      expect(again.data!.importGlobalModels).toEqual([]);
    } finally {
      await adminGql(DELETE_PROVIDER, { id: providerId }, token);
    }
  });

  it('T-MI4: flags cross-provider duplicates and rejects importing them', async () => {
    const makeProvider = async (suffix: string) => {
      const created = await adminGql<{ createGlobalProvider: { id: string } }>(CREATE_PROVIDER, {
        input: {
          name: `global-dupname-${suffix}-${Date.now()}`,
          type: 'OpenAI',
          endpoint: `http://127.0.0.1:${mock.port}/v1`,
          credentialType: 'api_key',
          credentialValue: 'sk-test-fake-key',
        },
      }, token);
      return created.data!.createGlobalProvider.id;
    };

    const a = await makeProvider('a');
    const b = await makeProvider('b');
    try {
      const first = await adminGql(IMPORT_MODELS, { providerId: a, names: ['gpt-4-turbo'] }, token);
      expect(first.errors).toBeUndefined();

      const listed = await adminGql<{ listGlobalProviderModels: Array<{ name: string; isDuplicate: boolean }> }>(
        LIST_PROVIDER_MODELS, { providerId: b }, token,
      );
      expect(listed.data!.listGlobalProviderModels.find((m) => m.name === 'gpt-4-turbo')!.isDuplicate).toBe(true);

      const rejected = await adminGql(IMPORT_MODELS, { providerId: b, names: ['gpt-4-turbo'] }, token);
      expect(rejected.errors).toBeDefined();
      expect(rejected.errors![0].message).toBe('Model name already exists: gpt-4-turbo');

      const models = await adminGql<{ adminModelsByProvider: Array<{ name: string }> }>(
        MODELS_BY_PROVIDER, { providerId: b }, token,
      );
      expect(models.data!.adminModelsByProvider).toEqual([]);
    } finally {
      await adminGql(DELETE_PROVIDER, { id: a }, token);
      await adminGql(DELETE_PROVIDER, { id: b }, token);
    }
  });

  it('T-MI5/T-MI6: normalizes connectivity failures and rejects blank names', async () => {
    const created = await adminGql<{ createGlobalProvider: { id: string } }>(CREATE_PROVIDER, {
      input: {
        name: `global-import-bad-${Date.now()}`,
        type: 'OpenAI',
        endpoint: `http://127.0.0.1:${mock.port}/v1`,
        credentialType: 'api_key',
        credentialValue: 'sk-test-fake-key',
      },
    }, token);
    const providerId = created.data!.createGlobalProvider.id;

    try {
      const invalid = await adminGql(IMPORT_MODELS, { providerId, names: ['  ', 'gpt-4o'] }, token);
      expect(invalid.errors).toBeDefined();
      expect(invalid.errors![0].message).toBe('Model name is invalid');
    } finally {
      await adminGql(DELETE_PROVIDER, { id: providerId }, token);
    }
  });

  it('T-MD1/T-MU1: deletes imported models, allows re-import, and rejects duplicate custom names', async () => {
    const created = await adminGql<{ createGlobalProvider: { id: string } }>(CREATE_PROVIDER, {
      input: {
        name: `global-delete-${Date.now()}`,
        type: 'OpenAI',
        endpoint: `http://127.0.0.1:${mock.port}/v1`,
        credentialType: 'api_key',
        credentialValue: 'sk-test-fake-key',
      },
    }, token);
    const providerId = created.data!.createGlobalProvider.id;

    try {
      const imported = await adminGql<{ importGlobalModels: Array<{ id: string; name: string }> }>(
        IMPORT_MODELS, { providerId, names: ['gpt-3.5-turbo'] }, token,
      );
      const modelId = imported.data!.importGlobalModels[0].id;

      const customDup = await adminGql(CREATE_CUSTOM_MODEL, { input: { providerId, name: 'gpt-3.5-turbo' } }, token);
      expect(customDup.errors).toBeDefined();
      expect(customDup.errors![0].message).toBe('Model name already exists: gpt-3.5-turbo');

      const deleted = await adminGql<{ deleteGlobalModel: { id: string; isCustom: boolean } }>(
        DELETE_MODEL, { id: modelId }, token,
      );
      expect(deleted.errors).toBeUndefined();
      expect(deleted.data!.deleteGlobalModel.id).toBe(modelId);

      const reimported = await adminGql<{ importGlobalModels: Array<{ name: string }> }>(
        IMPORT_MODELS, { providerId, names: ['gpt-3.5-turbo'] }, token,
      );
      expect(reimported.data!.importGlobalModels.map((m) => m.name)).toEqual(['gpt-3.5-turbo']);
    } finally {
      await adminGql(DELETE_PROVIDER, { id: providerId }, token);
    }
  });

  it('T-MR1/T-MR2: exposes the read-only rename ledger with the documented fields', async () => {
    const body = await adminGql<{ modelRenameRecords: Array<Record<string, unknown>> }>(
      RENAME_RECORDS, undefined, token,
    );
    expect(body.errors).toBeUndefined();
    for (const record of body.data!.modelRenameRecords) {
      expect(typeof record.id).toBe('string');
      expect(typeof record.modelId).toBe('string');
      expect(typeof record.providerId).toBe('string');
      expect(typeof record.providerName).toBe('string');
      expect(typeof record.oldName).toBe('string');
      expect(typeof record.newName).toBe('string');
      expect(typeof record.batchId).toBe('string');
      expect(typeof record.renamedAt).toBe('string');
    }
  });

  it.skipIf(!process.env.MONGODB_URI)(
    'problem 53: adminModels succeeds with provider=null for a dangling providerId',
    async () => {
      const uri = process.env.MONGODB_URI!;
      const name = `global-orphan-${Date.now()}`;
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
      expect(created.errors).toBeUndefined();
      const providerId = created.data!.createGlobalProvider.id;
      const modelId = created.data!.createGlobalProvider.models[0]?.id;
      expect(modelId).toBeTruthy();

      if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
      const db = mongoose.connection.db!;
      // 悬空 providerId：指向一个不存在的供应商，复现问题 53
      await db.collection('models').updateOne(
        { _id: new mongoose.Types.ObjectId(modelId!) },
        { $set: { providerId: new mongoose.Types.ObjectId('000000000000000000000000') } },
      );

      try {
        const models = await adminGql<{ adminModels: Array<{ id: string; provider: unknown }> }>(
          MODELS,
          undefined,
          token,
        );
        // 修复后：非空违规消除，整条查询成功，悬空模型 provider 为 null
        expect(models.errors).toBeUndefined();
        const orphan = models.data!.adminModels.find((m) => m.id === modelId);
        expect(orphan).toBeDefined();
        expect(orphan!.provider).toBeNull();
      } finally {
        // 直接清理悬空模型 + 级联删除供应商（providerId 已改，级联删不到该模型）
        await db.collection('models').deleteOne({ _id: new mongoose.Types.ObjectId(modelId!) });
        await adminGql(DELETE_PROVIDER, { id: providerId }, token);
      }
    },
  );

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
