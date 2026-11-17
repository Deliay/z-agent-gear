import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  providerService: {
    findAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    toggle: vi.fn(),
    batchEnable: vi.fn(),
    batchDisable: vi.fn(),
    batchDelete: vi.fn(),
    findSummaryById: vi.fn(),
    getDecryptedConnection: vi.fn(),
  },
  pushModelProvisionForTenant: vi.fn(),
}));

vi.mock('../../services/provider.js', () => ({ providerService: mocks.providerService }));
vi.mock('../../services/model.js', () => ({
  modelService: { findAll: vi.fn(), findByProviderId: vi.fn() },
}));
vi.mock('../../services/llm-api.js', () => ({
  llmApiService: { fetchModelCatalog: vi.fn() },
}));
vi.mock('../../services/acp-options-cache.js', () => ({
  invalidateAcpOptionsForUser: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../services/cloud-host-model-push.js', () => ({
  pushModelProvisionForTenant: mocks.pushModelProvisionForTenant,
}));

import { providerResolvers } from './provider.js';

const Mutation = providerResolvers.Mutation as any;
const context = { currentUser: { id: 'user1', tenantId: 'tenant-1' }, tenantId: 'tenant-1' };
const INPUT = {
  name: 'My OpenAI',
  type: 'OpenAI',
  endpoint: 'https://api.openai.com/v1',
  credentialType: 'api_key',
  credentialValue: 'sk-x',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pushModelProvisionForTenant.mockResolvedValue(undefined);
});

describe('provider mutations schedule the model push（T-CP5）', () => {
  it('pushes once after every successful user-side provider mutation', async () => {
    mocks.providerService.create.mockResolvedValue({ id: 'p1' });
    mocks.providerService.update.mockResolvedValue({ id: 'p1' });
    mocks.providerService.delete.mockResolvedValue(true);
    mocks.providerService.toggle.mockResolvedValue({ id: 'p1' });
    mocks.providerService.batchEnable.mockResolvedValue({ successCount: 1 });
    mocks.providerService.batchDisable.mockResolvedValue({ successCount: 2 });
    mocks.providerService.batchDelete.mockResolvedValue({ successCount: 3 });

    await Mutation.createProvider({}, { input: INPUT }, context);
    await Mutation.updateProvider({}, { id: 'p1', input: INPUT }, context);
    await Mutation.deleteProvider({}, { id: 'p1' }, context);
    await Mutation.toggleProvider({}, { id: 'p1' }, context);
    await Mutation.batchEnableProviders({}, { ids: ['p1'] }, context);
    await Mutation.batchDisableProviders({}, { ids: ['p1'] }, context);
    await Mutation.batchDeleteProviders({}, { ids: ['p1'] }, context);

    await vi.waitFor(() =>
      expect(mocks.pushModelProvisionForTenant).toHaveBeenCalledTimes(7),
    );
    expect(mocks.pushModelProvisionForTenant).toHaveBeenCalledWith('tenant-1');
  });

  it('keeps zero side effects on failure paths', async () => {
    mocks.providerService.create.mockRejectedValue(new Error('connect ECONNREFUSED'));
    mocks.providerService.update.mockResolvedValue(null);
    mocks.providerService.delete.mockResolvedValue(false);
    mocks.providerService.toggle.mockResolvedValue(null);
    mocks.providerService.batchEnable.mockResolvedValue({ successCount: 0 });
    mocks.providerService.batchDisable.mockRejectedValue(new Error('全局配置请在管理后台修改'));
    mocks.providerService.batchDelete.mockResolvedValue({ successCount: 0 });

    await expect(Mutation.createProvider({}, { input: INPUT }, context)).rejects.toThrow();
    await expect(
      Mutation.updateProvider({}, { id: 'p1', input: INPUT }, context),
    ).rejects.toThrow('Provider not found');
    await expect(Mutation.deleteProvider({}, { id: 'p1' }, context)).resolves.toBe(false);
    await expect(Mutation.toggleProvider({}, { id: 'p1' }, context)).rejects.toThrow(
      'Provider not found',
    );
    await expect(
      Mutation.batchEnableProviders({}, { ids: [] }, context),
    ).resolves.toEqual({ successCount: 0 });
    await expect(
      Mutation.batchDisableProviders({}, { ids: ['p1'] }, context),
    ).rejects.toThrow('全局配置请在管理后台修改');
    await expect(
      Mutation.batchDeleteProviders({}, { ids: [] }, context),
    ).resolves.toEqual({ successCount: 0 });

    await Promise.resolve();
    expect(mocks.pushModelProvisionForTenant).not.toHaveBeenCalled();
  });

  it('never rejects the mutation when the push fails', async () => {
    mocks.providerService.create.mockResolvedValue({ id: 'p1' });
    mocks.pushModelProvisionForTenant.mockRejectedValue(new Error('control plane down'));

    await expect(
      Mutation.createProvider({}, { input: INPUT }, context),
    ).resolves.toEqual({ id: 'p1' });
    await vi.waitFor(() =>
      expect(mocks.pushModelProvisionForTenant).toHaveBeenCalledTimes(1),
    );
  });

  it('rejects anonymous callers without pushing', async () => {
    await expect(
      Mutation.createProvider({}, { input: INPUT }, { currentUser: null }),
    ).rejects.toThrow('Not authenticated');
    expect(mocks.providerService.create).not.toHaveBeenCalled();
    expect(mocks.pushModelProvisionForTenant).not.toHaveBeenCalled();
  });
});
