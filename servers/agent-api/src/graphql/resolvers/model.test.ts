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
  },
}));

vi.mock('../../services/provider.js', () => ({
  providerService: { findSummaryById: vi.fn() },
}));

import { modelService } from '../../services/model.js';
import { providerService } from '../../services/provider.js';

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
