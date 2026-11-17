import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSchema, graphql, type GraphQLFieldResolver } from 'graphql';
import { modelResolvers } from './model.js';
import { modelTypeDefs } from '../schemas/model.js';
import { providerTypeDefs } from '../schemas/provider.js';

vi.mock('../../services/model.js', () => ({
  modelService: {
    findAll: vi.fn(),
    findByProviderId: vi.fn(),
    createCustom: vi.fn(),
    delete: vi.fn(),
    toggle: vi.fn(),
    updateSortOrder: vi.fn(),
    updateContextLength: vi.fn(),
  },
}));

vi.mock('../../services/provider.js', () => ({
  providerService: { findSummaryById: vi.fn(), getDecryptedConnection: vi.fn() },
}));

vi.mock('../../services/acp-options-cache.js', () => ({
  invalidateAcpOptionsForUser: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../services/cloud-host-model-push.js', () => ({
  pushModelProvisionForTenant: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/llm-api.js', () => ({
  llmApiService: { fetchModelCatalog: vi.fn() },
}));

import { modelService } from '../../services/model.js';
import { providerService } from '../../services/provider.js';
import { pushModelProvisionForTenant } from '../../services/cloud-host-model-push.js';
import { llmApiService } from '../../services/llm-api.js';

const mockContext = { currentUser: { id: 'user1', username: 'testuser' } };

const Model = modelResolvers.Model as {
  provider: (parent: { providerId: string; scope?: string }) => Promise<unknown>;
  providerId: (parent: { providerId: string; scope?: string }) => string | null;
};

describe('modelResolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Model.provider', () => {
    it('returns null for global models without querying the provider (never leaks backend name/type)', async () => {
      const result = await Model.provider({ providerId: 'p-global', scope: 'global' });

      expect(result).toBeNull();
      expect(providerService.findSummaryById).not.toHaveBeenCalled();
    });

    it('masks providerId for global models', () => {
      expect(Model.providerId({ providerId: 'p-global', scope: 'global' })).toBeNull();
      expect(Model.providerId({ providerId: 'p-user', scope: 'user' })).toBe('p-user');
    });

    it('delegates user-model provider lookup to providerService.findSummaryById (never the credential-bearing findById)', async () => {
      (providerService.findSummaryById as any).mockResolvedValue({
        id: 'p1',
        name: 'Global OpenAI',
        type: 'OpenAI',
        isEnabled: true,
        scope: 'global',
      });

      const result = await Model.provider({ providerId: 'p1' });

      expect(providerService.findSummaryById).toHaveBeenCalledWith('p1');
      expect(result).toEqual({
        id: 'p1',
        name: 'Global OpenAI',
        type: 'OpenAI',
        isEnabled: true,
        scope: 'global',
      });
    });

    it('does not expose endpoint / credential fields on the returned provider summary', async () => {
      (providerService.findSummaryById as any).mockResolvedValue({
        id: 'p1',
        name: 'Global OpenAI',
        type: 'OpenAI',
        isEnabled: true,
        scope: 'global',
      });

      const result = (await Model.provider({ providerId: 'p1' })) as Record<string, unknown>;

      expect(result).not.toHaveProperty('endpoint');
      expect(result).not.toHaveProperty('credentialType');
      expect(result).not.toHaveProperty('credentialValue');
      expect(result).not.toHaveProperty('encryptedCredential');
    });

    it('returns null when the provider is missing', async () => {
      (providerService.findSummaryById as any).mockResolvedValue(null);
      await expect(Model.provider({ providerId: 'missing' })).resolves.toBeNull();
    });

    it('keeps the models query succeeding with provider: null for a dangling providerId (issue 51)', async () => {
      (modelService.findAll as any).mockResolvedValue([
        {
          id: 'm-orphan',
          providerId: '000000000000000000000000',
          name: 'orphan-model',
          isCustom: false,
          isEnabled: true,
          sortOrder: 0,
          scope: 'user',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
      // providerId 悬空：供应商已不存在 → findSummaryById 返回 null
      (providerService.findSummaryById as any).mockResolvedValue(null);

      // 用真实 SDL 构建 schema：若 Model.provider 仍为非空，执行会返回
      // "Cannot return null for non-nullable field Model.provider"。
      const schema = buildSchema(
        ['type Query', 'type Mutation', providerTypeDefs, modelTypeDefs].join('\n'),
      );

      const query = modelResolvers.Query as {
        models: (parent: unknown, args: unknown, context: unknown) => unknown;
      };
      const fieldResolver: GraphQLFieldResolver<Record<string, unknown>, unknown> = (
        source,
        args,
        context,
        info,
      ) => {
        if (info.parentType.name === 'Query' && info.fieldName === 'models') {
          return query.models(source, args, context);
        }
        if (info.parentType.name === 'Model' && info.fieldName === 'provider') {
          return Model.provider(source as { providerId: string });
        }
        const value = source?.[info.fieldName];
        return typeof value === 'function' ? value.call(source, args, context, info) : value;
      };

      const result = await graphql({
        schema,
        source: '{ models { id provider { id } } }',
        contextValue: mockContext,
        fieldResolver,
      });

      expect(result.errors).toBeUndefined();
      const models = (result.data as { models: Array<{ id: string; provider: unknown }> }).models;
      expect(models).toHaveLength(1);
      expect(models[0].provider).toBeNull();
    });
  });

  describe('query guard (sanity)', () => {
    it('rejects anonymous models query', async () => {
      await expect(
        (modelResolvers.Query as any).models({}, {}, { currentUser: null }),
      ).rejects.toThrow('Not authenticated');
    });

    it('delegates models query when authenticated', async () => {
      (modelService.findAll as any).mockResolvedValue([{ id: 'm1' }]);
      await expect(
        (modelResolvers.Query as any).models({}, {}, mockContext),
      ).resolves.toEqual([{ id: 'm1' }]);
    });
  });
});

describe('providerModelOptions（T-UMC5）', () => {
  const Query = modelResolvers.Query as any;
  const context = { currentUser: { id: 'user1' }, tenantId: 'tenant-1' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects anonymous callers', async () => {
    await expect(
      Query.providerModelOptions({}, { providerId: 'p1' }, { currentUser: null }),
    ).rejects.toThrow('Not authenticated');
  });

  it('rejects when the provider is not visible to the user', async () => {
    (providerService.getDecryptedConnection as any).mockResolvedValue(null);

    await expect(
      Query.providerModelOptions({}, { providerId: 'p1' }, context),
    ).rejects.toThrow('Provider not found');
    expect(llmApiService.fetchModelCatalog).not.toHaveBeenCalled();
  });

  it('returns the upstream catalog with context lengths', async () => {
    (providerService.getDecryptedConnection as any).mockResolvedValue({
      type: 'OpenAI',
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-decrypted',
    });
    (llmApiService.fetchModelCatalog as any).mockResolvedValue([
      { name: 'gpt-4o', contextLength: 128000 },
      { name: 'gpt-4o-mini' },
    ]);

    await expect(
      Query.providerModelOptions({}, { providerId: 'p1' }, context),
    ).resolves.toEqual([
      { name: 'gpt-4o', contextLength: 128000 },
      { name: 'gpt-4o-mini' },
    ]);
    expect(providerService.getDecryptedConnection).toHaveBeenCalledWith('p1');
    expect(llmApiService.fetchModelCatalog).toHaveBeenCalledWith(
      'OpenAI',
      'https://api.openai.com/v1',
      'sk-decrypted',
    );
  });

  it('normalizes upstream failures to a readable message without leaking details', async () => {
    (providerService.getDecryptedConnection as any).mockResolvedValue({
      type: 'OpenAI',
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-decrypted',
    });
    (llmApiService.fetchModelCatalog as any).mockRejectedValue(
      new Error('401 invalid api key sk-decrypted at https://internal.example.com'),
    );

    await expect(
      Query.providerModelOptions({}, { providerId: 'p1' }, context),
    ).rejects.toThrow('拉取供应商模型清单失败，请检查 API 地址和凭据是否正确');
  });
});

describe('updateModelContextLength（T-UMC5）', () => {
  const Mutation = modelResolvers.Mutation as any;
  const context = { currentUser: { id: 'user1' }, tenantId: 'tenant-1' };

  beforeEach(() => {
    vi.clearAllMocks();
    (pushModelProvisionForTenant as any).mockResolvedValue(undefined);
  });

  it('requires authentication', async () => {
    await expect(
      Mutation.updateModelContextLength({}, { modelId: 'm1', contextLength: 1000 }, { currentUser: null }),
    ).rejects.toThrow('Not authenticated');
  });

  it('writes the value, invalidates ACP options and schedules a push', async () => {
    (modelService.updateContextLength as any).mockResolvedValue({
      id: 'm1',
      contextLength: 128000,
    });

    await expect(
      Mutation.updateModelContextLength({}, { modelId: 'm1', contextLength: 128000 }, context),
    ).resolves.toEqual({ id: 'm1', contextLength: 128000 });
    expect(modelService.updateContextLength).toHaveBeenCalledWith('m1', 128000);
    await vi.waitFor(() =>
      expect(pushModelProvisionForTenant).toHaveBeenCalledWith('tenant-1'),
    );
  });

  it('passes null when clearing the value', async () => {
    (modelService.updateContextLength as any).mockResolvedValue({ id: 'm1', contextLength: null });

    await Mutation.updateModelContextLength({}, { modelId: 'm1' }, context);
    expect(modelService.updateContextLength).toHaveBeenCalledWith('m1', null);
  });

  it('maps service errors to GraphQLError messages verbatim', async () => {
    (modelService.updateContextLength as any).mockRejectedValue(new Error('Model not found'));

    await expect(
      Mutation.updateModelContextLength({}, { modelId: 'm1', contextLength: 1000 }, context),
    ).rejects.toThrow('Model not found');
  });

  it('maps invalid context length errors verbatim', async () => {
    (modelService.updateContextLength as any).mockRejectedValue(
      new Error('contextLength must be a positive integer'),
    );

    await expect(
      Mutation.updateModelContextLength({}, { modelId: 'm1', contextLength: 0 }, context),
    ).rejects.toThrow('contextLength must be a positive integer');
  });
});

describe('model mutations schedule the model push（T-CP5）', () => {
  const Mutation = modelResolvers.Mutation as any;
  const context = { currentUser: { id: 'user1', tenantId: 'tenant-9' }, tenantId: 'tenant-9' };

  beforeEach(() => {
    vi.clearAllMocks();
    (pushModelProvisionForTenant as any).mockResolvedValue(undefined);
  });

  it('pushes once with the tenant id after createCustomModel (contextLength passthrough)', async () => {
    (modelService.createCustom as any).mockResolvedValue({ id: 'm1' });

    await Mutation.createCustomModel(
      {},
      { input: { providerId: 'p1', name: 'custom', contextLength: 128000 } },
      context,
    );

    expect(modelService.createCustom).toHaveBeenCalledWith({
      providerId: 'p1',
      name: 'custom',
      contextLength: 128000,
    });
    await vi.waitFor(() =>
      expect(pushModelProvisionForTenant).toHaveBeenCalledTimes(1),
    );
    expect(pushModelProvisionForTenant).toHaveBeenCalledWith('tenant-9');
  });

  it('pushes after deleteCustomModel / toggleModel / updateModelSortOrder', async () => {
    (modelService.delete as any).mockResolvedValue({ id: 'm1' });
    (modelService.toggle as any).mockResolvedValue({ id: 'm2' });
    (modelService.updateSortOrder as any).mockResolvedValue([{ id: 'm3' }]);

    await Mutation.deleteCustomModel({}, { id: 'm1' }, context);
    await Mutation.toggleModel({}, { id: 'm2' }, context);
    await Mutation.updateModelSortOrder({}, { ids: ['m3'] }, context);

    await vi.waitFor(() =>
      expect(pushModelProvisionForTenant).toHaveBeenCalledTimes(3),
    );
  });

  it('does not push on failure paths', async () => {
    (modelService.delete as any).mockResolvedValue(null);
    (modelService.createCustom as any).mockRejectedValue(new Error('Provider not found'));

    await expect(Mutation.deleteCustomModel({}, { id: 'm1' }, context)).rejects.toThrow(
      'Model not found or is not a custom model',
    );
    await expect(
      Mutation.createCustomModel({}, { input: { providerId: 'p1', name: 'x' } }, context),
    ).rejects.toThrow('Provider not found');

    // 让可能排入的微任务跑完，再断言零副作用
    await Promise.resolve();
    expect(pushModelProvisionForTenant).not.toHaveBeenCalled();
  });

  it('swallows push rejections (mutation still succeeds)', async () => {
    (modelService.createCustom as any).mockResolvedValue({ id: 'm1' });
    (pushModelProvisionForTenant as any).mockRejectedValue(new Error('push down'));

    await expect(
      Mutation.createCustomModel({}, { input: { providerId: 'p1', name: 'x' } }, context),
    ).resolves.toEqual({ id: 'm1' });
    await vi.waitFor(() =>
      expect(pushModelProvisionForTenant).toHaveBeenCalledTimes(1),
    );
  });
});
