import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modelResolvers } from './model';

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
  providerService: { findById: vi.fn() },
}));

import { modelService } from '../../services/model.js';
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
  });

  describe('mutations', () => {
    it('T-M1: createGlobalCustomModel maps duplicate name error', async () => {
      (modelService.createCustom as any).mockRejectedValue(new Error('E11000 duplicate key error'));
      await expect(
        Mutation.createGlobalCustomModel({}, { input: { providerId: 'p1', name: 'dup' } }, good),
      ).rejects.toThrow('Model name already exists for this provider');
    });

    it('createGlobalCustomModel returns the created model', async () => {
      (modelService.createCustom as any).mockResolvedValue({ id: 'm1', isCustom: true });
      await expect(
        Mutation.createGlobalCustomModel({}, { input: { providerId: 'p1', name: 'x' } }, good),
      ).resolves.toEqual({ id: 'm1', isCustom: true });
    });

    it('T-M2: deleteGlobalCustomModel throws when not deletable', async () => {
      (modelService.delete as any).mockResolvedValue(null);
      await expect(Mutation.deleteGlobalCustomModel({}, { id: 'm1' }, good)).rejects.toThrow(
        'Model not found or is not a custom model',
      );
    });

    it('deleteGlobalCustomModel returns the deleted model', async () => {
      (modelService.delete as any).mockResolvedValue({ id: 'm1' });
      await expect(Mutation.deleteGlobalCustomModel({}, { id: 'm1' }, good)).resolves.toEqual({ id: 'm1' });
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
  });
});
