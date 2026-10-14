import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  providerFindById: vi.fn(),
}));

// 仅 services/model.ts 使用 mongoose（Types.ObjectId + mongoose.model('Provider')）
vi.mock('mongoose', () => ({
  default: {
    Types: {
      ObjectId: class {
        constructor(private value: string) {}
        toString() {
          return this.value;
        }
      },
    },
    model: vi.fn(() => ({ findById: mocks.providerFindById })),
  },
}));

// 用工厂显式返回 mock，避免加载真实 model.ts（其中依赖被 mock 的 mongoose）
vi.mock('../models/model.js', () => ({
  Model: {
    find: vi.fn(),
    findOne: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    deleteOne: vi.fn(),
    bulkWrite: vi.fn(),
  },
}));

import { Model } from '../models/model.js';
import { modelService } from './model';

function makeModelDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'model-1' },
    providerId: { toString: () => 'provider-1' },
    name: 'gpt-4o',
    isCustom: false,
    isEnabled: true,
    sortOrder: 0,
    scope: 'global',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('ModelService (admin / global scope)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findAll', () => {
    it('queries only scope=global', async () => {
      const lean = vi.fn().mockResolvedValue([makeModelDoc()]);
      (Model.find as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean }) });

      const result = await modelService.findAll();

      expect(Model.find).toHaveBeenCalledWith({ scope: 'global' });
      expect(result[0].scope).toBe('global');
    });
  });

  describe('findByProviderId', () => {
    it('adds scope=global to the filter', async () => {
      const lean = vi.fn().mockResolvedValue([makeModelDoc()]);
      (Model.find as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean }) });

      await modelService.findByProviderId('provider-1');

      expect(Model.find).toHaveBeenCalledWith({ providerId: 'provider-1', scope: 'global' });
    });
  });

  describe('createCustom', () => {
    beforeEach(() => {
      (Model.findOne as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ sortOrder: 2 }) }),
        }),
      });
    });

    it('T-M1: writes scope=global, isCustom=true and appends sortOrder', async () => {
      const custom = makeModelDoc({ _id: { toString: () => 'model-new' }, name: 'custom-model', isCustom: true, sortOrder: 3 });
      const create = vi.fn().mockResolvedValue({ ...custom, toObject: () => custom });
      (Model.create as any) = create;

      const result = await modelService.createCustom({ providerId: 'provider-1', name: 'custom-model' });

      expect(Model.findOne).toHaveBeenCalledWith({ providerId: 'provider-1', scope: 'global' });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'custom-model', isCustom: true, sortOrder: 3, scope: 'global' }),
      );
      expect(result.isCustom).toBe(true);
      expect(result.sortOrder).toBe(3);
      expect(result.scope).toBe('global');
    });

    it('T-M1: surfaces duplicate model name error (E11000)', async () => {
      (Model.create as any) = vi.fn().mockRejectedValue(new Error('E11000 duplicate key error'));

      await expect(modelService.createCustom({ providerId: 'provider-1', name: 'dup' })).rejects.toThrow('E11000');
    });
  });

  describe('delete', () => {
    it('T-M2: deletes a global custom model', async () => {
      const doc = makeModelDoc({ isCustom: true });
      (Model.findById as any).mockResolvedValue({ ...doc, toObject: () => doc });
      (Model.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      const result = await modelService.delete('model-1');

      expect(result).not.toBeNull();
      expect(result!.isCustom).toBe(true);
      expect(Model.deleteOne).toHaveBeenCalledWith({ _id: 'model-1' });
    });

    it('T-M2: refuses to delete a synced (non-custom) model', async () => {
      (Model.findById as any).mockResolvedValue(makeModelDoc({ isCustom: false }));

      expect(await modelService.delete('model-1')).toBeNull();
      expect(Model.deleteOne).not.toHaveBeenCalled();
    });

    it('T-M2: refuses to delete a user-scope model', async () => {
      (Model.findById as any).mockResolvedValue(makeModelDoc({ scope: 'user', isCustom: true }));

      expect(await modelService.delete('model-1')).toBeNull();
      expect(Model.deleteOne).not.toHaveBeenCalled();
    });

    it('returns null when model does not exist', async () => {
      (Model.findById as any).mockResolvedValue(null);
      expect(await modelService.delete('missing')).toBeNull();
    });
  });

  describe('toggle', () => {
    it('T-M3: toggles a global model when its provider is enabled', async () => {
      const doc = {
        ...makeModelDoc({ isEnabled: false }),
        save: vi.fn().mockResolvedValue(undefined),
        toObject: () => makeModelDoc({ isEnabled: true }),
      };
      (Model.findById as any).mockResolvedValue(doc);
      mocks.providerFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue({ isEnabled: true }) });

      const result = await modelService.toggle('model-1');

      expect(result).not.toBeNull();
      expect(doc.isEnabled).toBe(true);
      expect(doc.save).toHaveBeenCalledTimes(1);
      expect(mocks.providerFindById).toHaveBeenCalledWith(doc.providerId);
    });

    it('T-M3: refuses to toggle when provider is disabled', async () => {
      (Model.findById as any).mockResolvedValue(makeModelDoc());
      mocks.providerFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue({ isEnabled: false }) });

      expect(await modelService.toggle('model-1')).toBeNull();
    });

    it('T-M3: refuses to toggle when provider is missing', async () => {
      (Model.findById as any).mockResolvedValue(makeModelDoc());
      mocks.providerFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      expect(await modelService.toggle('model-1')).toBeNull();
    });

    it('T-M3: refuses to toggle a user-scope model', async () => {
      (Model.findById as any).mockResolvedValue(makeModelDoc({ scope: 'user' }));

      expect(await modelService.toggle('model-1')).toBeNull();
    });

    it('returns null when model does not exist', async () => {
      (Model.findById as any).mockResolvedValue(null);
      expect(await modelService.toggle('missing')).toBeNull();
    });
  });

  describe('updateSortOrder', () => {
    it('T-M4: persists order and re-reads only global models', async () => {
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});
      const lean = vi.fn().mockResolvedValue([makeModelDoc()]);
      (Model.find as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean }) });

      const result = await modelService.updateSortOrder(['model-2', 'model-1']);

      expect(Model.bulkWrite).toHaveBeenCalledWith([
        { updateOne: { filter: { _id: 'model-2', scope: 'global' }, update: { sortOrder: 0 } } },
        { updateOne: { filter: { _id: 'model-1', scope: 'global' }, update: { sortOrder: 1 } } },
      ]);
      expect(Model.find).toHaveBeenCalledWith({ _id: { $in: ['model-2', 'model-1'] }, scope: 'global' });
      expect(result).toHaveLength(1);
    });
  });
});
