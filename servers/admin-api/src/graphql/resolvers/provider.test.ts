import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { providerResolvers } from './provider';

vi.mock('../../services/provider.js', () => ({
  PROVIDER_CONNECTIVITY_ERROR: '供应商连通性测试失败，请检查 API 地址和凭据是否正确',
  providerService: {
    findAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    toggle: vi.fn(),
    batchEnable: vi.fn(),
    batchDisable: vi.fn(),
    batchDelete: vi.fn(),
  },
}));

vi.mock('../../services/model.js', () => ({
  modelService: { findByProviderId: vi.fn() },
}));

import { providerService } from '../../services/provider.js';
import { modelService } from '../../services/model.js';
import type { AdminAuthContext } from './auth.js';

const good: AdminAuthContext = { currentAdmin: { id: 'a1', username: 'admin', mustChangePassword: false } };
const locked: AdminAuthContext = { currentAdmin: { id: 'a1', username: 'admin', mustChangePassword: true } };
const anon: AdminAuthContext = { currentAdmin: null };

const Query = providerResolvers.Query as any;
const Mutation = providerResolvers.Mutation as any;
const Provider = providerResolvers.Provider as any;

const input = {
  name: 'Global OpenAI',
  type: 'OpenAI',
  endpoint: 'https://api.openai.com/v1',
  credentialType: 'api_key',
  credentialValue: 'sk-key',
};

describe('providerResolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('guard', () => {
    it('T-A7: rejects anonymous access to adminProviders', async () => {
      await expect(Query.adminProviders({}, {}, anon)).rejects.toThrow('Not authenticated');
    });

    it('T-A7: rejects mustChangePassword access with MUST_CHANGE_PASSWORD', async () => {
      await expect(Query.adminProviders({}, {}, locked)).rejects.toThrow('MUST_CHANGE_PASSWORD');
    });

    it('allows a fully authenticated admin', async () => {
      (providerService.findAll as any).mockResolvedValue([{ id: 'p1' }]);
      await expect(Query.adminProviders({}, {}, good)).resolves.toEqual([{ id: 'p1' }]);
    });
  });

  describe('createGlobalProvider', () => {
    it('T-P7: maps duplicate name error', async () => {
      (providerService.create as any).mockRejectedValue(new Error('E11000 duplicate key error'));
      await expect(Mutation.createGlobalProvider({}, { input }, good)).rejects.toThrow(
        'Provider name already exists',
      );
    });

    it('T-P1: maps the service connectivity marker to the Chinese message', async () => {
      (providerService.create as any).mockRejectedValue(new Error('供应商连通性测试失败，请检查 API 地址和凭据是否正确'));
      await expect(Mutation.createGlobalProvider({}, { input }, good)).rejects.toThrow(
        '供应商连通性测试失败，请检查 API 地址和凭据是否正确',
      );
    });

    it('returns the created provider', async () => {
      (providerService.create as any).mockResolvedValue({ id: 'p1', scope: 'global' });
      await expect(Mutation.createGlobalProvider({}, { input }, good)).resolves.toEqual({ id: 'p1', scope: 'global' });
    });

    it('propagates other errors verbatim', async () => {
      (providerService.create as any).mockRejectedValue(new Error('Provider name is required'));
      await expect(Mutation.createGlobalProvider({}, { input }, good)).rejects.toThrow('Provider name is required');
    });
  });

  describe('updateGlobalProvider', () => {
    it('returns Provider not found when service returns null', async () => {
      (providerService.update as any).mockResolvedValue(null);
      await expect(Mutation.updateGlobalProvider({}, { id: 'p1', input }, good)).rejects.toThrow('Provider not found');
    });

    it('maps duplicate name error', async () => {
      (providerService.update as any).mockRejectedValue(new Error('E11000 duplicate key error'));
      await expect(Mutation.updateGlobalProvider({}, { id: 'p1', input }, good)).rejects.toThrow(
        'Provider name already exists',
      );
    });

    it('returns the updated provider', async () => {
      (providerService.update as any).mockResolvedValue({ id: 'p1' });
      await expect(Mutation.updateGlobalProvider({}, { id: 'p1', input }, good)).resolves.toEqual({ id: 'p1' });
    });
  });

  describe('delete / toggle / batch', () => {
    it('deleteGlobalProvider delegates', async () => {
      (providerService.delete as any).mockResolvedValue(true);
      await expect(Mutation.deleteGlobalProvider({}, { id: 'p1' }, good)).resolves.toBe(true);
    });

    it('toggleGlobalProvider throws when provider missing', async () => {
      (providerService.toggle as any).mockResolvedValue(null);
      await expect(Mutation.toggleGlobalProvider({}, { id: 'p1' }, good)).rejects.toThrow('Provider not found');
    });

    it('toggleGlobalProvider returns the provider', async () => {
      (providerService.toggle as any).mockResolvedValue({ id: 'p1' });
      await expect(Mutation.toggleGlobalProvider({}, { id: 'p1' }, good)).resolves.toEqual({ id: 'p1' });
    });

    it('batch mutations delegate to the service', async () => {
      (providerService.batchEnable as any).mockResolvedValue({ successCount: 1 });
      (providerService.batchDisable as any).mockResolvedValue({ successCount: 2 });
      (providerService.batchDelete as any).mockResolvedValue({ successCount: 3 });

      await expect(Mutation.batchEnableGlobalProviders({}, { ids: ['p1'] }, good)).resolves.toEqual({ successCount: 1 });
      await expect(Mutation.batchDisableGlobalProviders({}, { ids: ['p1'] }, good)).resolves.toEqual({ successCount: 2 });
      await expect(Mutation.batchDeleteGlobalProviders({}, { ids: ['p1'] }, good)).resolves.toEqual({ successCount: 3 });
    });
  });

  describe('Provider.models', () => {
    it('delegates to modelService.findByProviderId', async () => {
      (modelService.findByProviderId as any).mockResolvedValue([{ id: 'm1' }]);
      await expect(Provider.models({ id: 'p1' })).resolves.toEqual([{ id: 'm1' }]);
      expect(modelService.findByProviderId).toHaveBeenCalledWith('p1');
    });
  });
});
