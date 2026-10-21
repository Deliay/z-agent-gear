import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSchema, graphql, type GraphQLFieldResolver } from 'graphql';
import { modelResolvers } from './model';
import { modelTypeDefs } from '../schemas/model.js';
import { providerTypeDefs } from '../schemas/provider.js';

vi.mock('../../services/model.js', () => ({
  modelService: {
    findAll: vi.fn(),
    findByProviderId: vi.fn(),
    createCustom: vi.fn(),
    importModels: vi.fn(),
    listProviderModels: vi.fn(),
    delete: vi.fn(),
    toggle: vi.fn(),
    updateSortOrder: vi.fn(),
  },
}));

vi.mock('../../services/model-rename-record.js', () => ({
  modelRenameRecordService: { findAll: vi.fn() },
}));

vi.mock('../../services/provider.js', () => ({
  PROVIDER_CONNECTIVITY_ERROR: '供应商连通性测试失败，请检查 API 地址和凭据是否正确',
  providerService: { findById: vi.fn() },
}));

import { modelService } from '../../services/model.js';
import { modelRenameRecordService } from '../../services/model-rename-record.js';
import { providerService } from '../../services/provider.js';
import type { AdminAuthContext } from './auth.js';

const good: AdminAuthContext = { currentAdmin: { id: 'a1', username: 'admin', mustChangePassword: false } };
const locked: AdminAuthContext = { currentAdmin: { id: 'a1', username: 'admin', mustChangePassword: true } };
const anon: AdminAuthContext = { currentAdmin: null };

const Query = modelResolvers.Query as any;
const Mutation = modelResolvers.Mutation as any;
const Model = modelResolvers.Model as any;

describe('modelResolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('queries + guard', () => {
    it('T-A7: rejects anonymous access', async () => {
      await expect(Query.adminModels({}, {}, anon)).rejects.toThrow('Not authenticated');
    });

    it('T-A7: rejects mustChangePassword access', async () => {
      await expect(Query.adminModels({}, {}, locked)).rejects.toThrow('MUST_CHANGE_PASSWORD');
    });

    it('adminModels delegates', async () => {
      (modelService.findAll as any).mockResolvedValue([{ id: 'm1' }]);
      await expect(Query.adminModels({}, {}, good)).resolves.toEqual([{ id: 'm1' }]);
    });

    it('adminModelsByProvider delegates', async () => {
      (modelService.findByProviderId as any).mockResolvedValue([{ id: 'm1' }]);
      await expect(Query.adminModelsByProvider({}, { providerId: 'p1' }, good)).resolves.toEqual([{ id: 'm1' }]);
      expect(modelService.findByProviderId).toHaveBeenCalledWith('p1');
    });

    it('R-M1: new queries reject anonymous access', async () => {
      await expect(Query.listGlobalProviderModels({}, { providerId: 'p1' }, anon)).rejects.toThrow(
        'Not authenticated',
      );
      await expect(Query.modelRenameRecords({}, {}, anon)).rejects.toThrow('Not authenticated');
    });

    it('R-M2: listGlobalProviderModels delegates', async () => {
      (modelService.listProviderModels as any).mockResolvedValue([
        { name: 'gpt-4o', isImported: false, isDuplicate: false },
      ]);

      await expect(Query.listGlobalProviderModels({}, { providerId: 'p1' }, good)).resolves.toEqual([
        { name: 'gpt-4o', isImported: false, isDuplicate: false },
      ]);
      expect(modelService.listProviderModels).toHaveBeenCalledWith('p1');
    });

    it('R-M7: modelRenameRecords delegates', async () => {
      (modelRenameRecordService.findAll as any).mockResolvedValue([{ id: 'r1' }]);
      await expect(Query.modelRenameRecords({}, {}, good)).resolves.toEqual([{ id: 'r1' }]);
    });
  });

  describe('mutations', () => {
    it('T-M1: createGlobalCustomModel maps duplicate name error', async () => {
      (modelService.createCustom as any).mockRejectedValue(new Error('E11000 duplicate key error'));
      await expect(
        Mutation.createGlobalCustomModel({}, { input: { providerId: 'p1', name: 'dup' } }, good),
      ).rejects.toThrow('Model name already exists');
    });

    it('R-M6: createGlobalCustomModel propagates the global duplicate-name message', async () => {
      (modelService.createCustom as any).mockRejectedValue(new Error('Model name already exists: gpt-4o'));
      await expect(
        Mutation.createGlobalCustomModel({}, { input: { providerId: 'p1', name: 'gpt-4o' } }, good),
      ).rejects.toThrow('Model name already exists: gpt-4o');
    });

    it('createGlobalCustomModel returns the created model', async () => {
      (modelService.createCustom as any).mockResolvedValue({ id: 'm1', isCustom: true });
      await expect(
        Mutation.createGlobalCustomModel({}, { input: { providerId: 'p1', name: 'x' } }, good),
      ).resolves.toEqual({ id: 'm1', isCustom: true });
    });

    it('R-M3: importGlobalModels maps duplicate / connectivity / not-found errors verbatim', async () => {
      (modelService.importModels as any).mockRejectedValueOnce(new Error('Model name already exists: gpt-4o'));
      await expect(Mutation.importGlobalModels({}, { providerId: 'p1', names: ['gpt-4o'] }, good)).rejects.toThrow(
        'Model name already exists: gpt-4o',
      );

      (modelService.importModels as any).mockRejectedValueOnce(
        new Error('供应商连通性测试失败，请检查 API 地址和凭据是否正确'),
      );
      await expect(Mutation.importGlobalModels({}, { providerId: 'p1', names: ['gpt-4o'] }, good)).rejects.toThrow(
        '供应商连通性测试失败，请检查 API 地址和凭据是否正确',
      );

      (modelService.importModels as any).mockRejectedValueOnce(new Error('Provider not found'));
      await expect(Mutation.importGlobalModels({}, { providerId: 'p1', names: ['gpt-4o'] }, good)).rejects.toThrow(
        'Provider not found',
      );
    });

    it('importGlobalModels returns the created models', async () => {
      (modelService.importModels as any).mockResolvedValue([{ id: 'm1' }]);
      await expect(
        Mutation.importGlobalModels({}, { providerId: 'p1', names: ['gpt-4o'] }, good),
      ).resolves.toEqual([{ id: 'm1' }]);
      expect(modelService.importModels).toHaveBeenCalledWith('p1', ['gpt-4o']);
    });

    it('R-M4: deleteGlobalModel throws Model not found when the service returns null', async () => {
      (modelService.delete as any).mockResolvedValue(null);
      await expect(Mutation.deleteGlobalModel({}, { id: 'm1' }, good)).rejects.toThrow('Model not found');
    });

    it('R-M5: deleteGlobalModel returns the deleted model', async () => {
      (modelService.delete as any).mockResolvedValue({ id: 'm1', isCustom: false });
      await expect(Mutation.deleteGlobalModel({}, { id: 'm1' }, good)).resolves.toEqual({
        id: 'm1',
        isCustom: false,
      });
    });

    it('T-M3: toggleGlobalModel throws when provider disabled', async () => {
      (modelService.toggle as any).mockResolvedValue(null);
      await expect(Mutation.toggleGlobalModel({}, { id: 'm1' }, good)).rejects.toThrow(
        'Model not found or its provider is disabled',
      );
    });

    it('toggleGlobalModel returns the model', async () => {
      (modelService.toggle as any).mockResolvedValue({ id: 'm1', isEnabled: true });
      await expect(Mutation.toggleGlobalModel({}, { id: 'm1' }, good)).resolves.toEqual({ id: 'm1', isEnabled: true });
    });

    it('T-M4: updateGlobalModelSortOrder delegates', async () => {
      (modelService.updateSortOrder as any).mockResolvedValue([{ id: 'm1' }]);
      await expect(Mutation.updateGlobalModelSortOrder({}, { ids: ['m1'] }, good)).resolves.toEqual([{ id: 'm1' }]);
    });
  });

  describe('Model.provider', () => {
    it('delegates to providerService.findById', async () => {
      (providerService.findById as any).mockResolvedValue({ id: 'p1' });
      await expect(Model.provider({ providerId: 'p1' })).resolves.toEqual({ id: 'p1' });
      expect(providerService.findById).toHaveBeenCalledWith('p1');
    });

    it('keeps adminModels succeeding with provider: null for a dangling providerId (问题 53)', async () => {
      (modelService.findAll as any).mockResolvedValue([
        {
          id: 'm-orphan',
          providerId: '000000000000000000000000',
          name: 'orphan-model',
          isCustom: false,
          isEnabled: true,
          sortOrder: 0,
          scope: 'global',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
      // providerId 悬空：供应商已不存在 → findById 返回 null
      (providerService.findById as any).mockResolvedValue(null);

      // 用真实 SDL 构建 schema：若 Model.provider 仍为非空，执行会返回
      // "Cannot return null for non-nullable field Model.provider"。
      const schema = buildSchema(
        ['type Query', 'type Mutation', providerTypeDefs, modelTypeDefs].join('\n'),
      );
      const fieldResolver: GraphQLFieldResolver<Record<string, unknown>, unknown> = (
        source,
        args,
        context,
        info,
      ) => {
        if (info.parentType.name === 'Query' && info.fieldName === 'adminModels') {
          return (modelResolvers.Query as any).adminModels(source, args, context);
        }
        if (info.parentType.name === 'Model' && info.fieldName === 'provider') {
          return Model.provider(source as { providerId: string });
        }
        const value = source?.[info.fieldName];
        return typeof value === 'function' ? value.call(source, args, context, info) : value;
      };
      const result = await graphql({
        schema,
        source: '{ adminModels { id provider { id } } }',
        contextValue: good,
        fieldResolver,
      });

      expect(result.errors).toBeUndefined();
      const models = (result.data as { adminModels: Array<{ id: string; provider: unknown }> }).adminModels;
      expect(models).toHaveLength(1);
      expect(models[0].provider).toBeNull();
    });
  });
});
