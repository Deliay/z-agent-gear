import { describe, it, expect, vi, beforeEach } from 'vitest';

// services/model.ts 使用 mongoose.Types.ObjectId（构造 + isValid）
vi.mock('mongoose', () => ({
  default: {
    Types: {
      ObjectId: Object.assign(
        class {
          constructor(private value: string) {}
          toString() {
            return this.value;
          }
        },
        { isValid: (v: unknown) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) },
      ),
    },
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

vi.mock('../models/provider.js', () => ({
  Provider: {
    findOne: vi.fn(),
  },
}));

import { Model } from '../models/model.js';
import { Provider } from '../models/provider.js';
import { modelService } from './model';

const VALID_OID = '507f1f77bcf86cd799439011';
const VALID_OID_2 = '507f191e810c19729de860ea';

function makeModelDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'model-1' },
    providerId: { toString: () => VALID_OID },
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
    // 默认：目标供应商存在且为 global
    (Provider.findOne as any).mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: VALID_OID, scope: 'global' }) });
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

      await modelService.findByProviderId(VALID_OID);

      expect(Model.find).toHaveBeenCalledWith({ providerId: VALID_OID, scope: 'global' });
    });

    it('returns [] for a malformed providerId without touching the DB (问题 27)', async () => {
      await expect(modelService.findByProviderId('not-an-object-id')).resolves.toEqual([]);
      expect(Model.find).not.toHaveBeenCalled();
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

      const result = await modelService.createCustom({ providerId: VALID_OID, name: 'custom-model' });

      expect(Provider.findOne).toHaveBeenCalledWith({ _id: VALID_OID, scope: 'global' });
      expect(Model.findOne).toHaveBeenCalledWith({ providerId: VALID_OID, scope: 'global' });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'custom-model', isCustom: true, sortOrder: 3, scope: 'global' }),
      );
      expect(result.isCustom).toBe(true);
      expect(result.sortOrder).toBe(3);
      expect(result.scope).toBe('global');
    });

    it('T-M1: rejects duplicate model name error (E11000)', async () => {
      (Model.create as any) = vi.fn().mockRejectedValue(new Error('E11000 duplicate key error'));

      await expect(modelService.createCustom({ providerId: VALID_OID, name: 'dup' })).rejects.toThrow('E11000');
    });

    it('cross-scope guard: rejects when target provider is missing', async () => {
      (Provider.findOne as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      await expect(modelService.createCustom({ providerId: VALID_OID, name: 'x' })).rejects.toThrow('Provider not found');
      expect(Model.create).not.toHaveBeenCalled();
    });

    it('cross-scope guard: rejects a malformed providerId', async () => {
      await expect(modelService.createCustom({ providerId: 'user-provider', name: 'x' })).rejects.toThrow('Provider not found');
      expect(Model.create).not.toHaveBeenCalled();
    });

    it('建议 I: trims the name and rejects an empty/whitespace name', async () => {
      const custom = makeModelDoc({ _id: { toString: () => 'model-new' }, name: 'custom-model', isCustom: true, sortOrder: 3 });
      const create = vi.fn().mockResolvedValue({ ...custom, toObject: () => custom });
      (Model.create as any) = create;

      await modelService.createCustom({ providerId: VALID_OID, name: '  custom-model  ' });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'custom-model' }));

      create.mockClear();
      await expect(
        modelService.createCustom({ providerId: VALID_OID, name: '   ' }),
      ).rejects.toThrow('Model name is required');
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('T-M2: deletes a global custom model', async () => {
      const doc = makeModelDoc({ isCustom: true });
      (Model.findById as any).mockResolvedValue({ ...doc, toObject: () => doc });
      (Model.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      const result = await modelService.delete(VALID_OID);

      expect(result).not.toBeNull();
      expect(result!.isCustom).toBe(true);
      expect(Model.deleteOne).toHaveBeenCalledWith({ _id: VALID_OID });
    });

    it('T-M2: refuses to delete a synced (non-custom) model', async () => {
      (Model.findById as any).mockResolvedValue(makeModelDoc({ isCustom: false }));

      expect(await modelService.delete(VALID_OID)).toBeNull();
      expect(Model.deleteOne).not.toHaveBeenCalled();
    });

    it('T-M2: refuses to delete a user-scope model', async () => {
      (Model.findById as any).mockResolvedValue(makeModelDoc({ scope: 'user', isCustom: true }));

      expect(await modelService.delete(VALID_OID)).toBeNull();
      expect(Model.deleteOne).not.toHaveBeenCalled();
    });

    it('returns null when model does not exist', async () => {
      (Model.findById as any).mockResolvedValue(null);
      expect(await modelService.delete(VALID_OID)).toBeNull();
    });

    it('returns null for a malformed ObjectId without touching the DB (问题 27)', async () => {
      expect(await modelService.delete('not-an-object-id')).toBeNull();
      expect(Model.findById).not.toHaveBeenCalled();
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
      (Provider.findOne as any).mockReturnValue({ lean: vi.fn().mockResolvedValue({ isEnabled: true }) });

      const result = await modelService.toggle(VALID_OID);

      expect(result).not.toBeNull();
      expect(doc.isEnabled).toBe(true);
      expect(doc.save).toHaveBeenCalledTimes(1);
      expect(Provider.findOne).toHaveBeenCalledWith({ _id: doc.providerId, scope: 'global' });
    });

    it('T-M3: refuses to toggle when provider is disabled', async () => {
      (Model.findById as any).mockResolvedValue(makeModelDoc());
      (Provider.findOne as any).mockReturnValue({ lean: vi.fn().mockResolvedValue({ isEnabled: false }) });

      expect(await modelService.toggle(VALID_OID)).toBeNull();
    });

    it('T-M3: refuses to toggle when provider is missing', async () => {
      (Model.findById as any).mockResolvedValue(makeModelDoc());
      (Provider.findOne as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      expect(await modelService.toggle(VALID_OID)).toBeNull();
    });

    it('T-M3: refuses to toggle a user-scope model', async () => {
      (Model.findById as any).mockResolvedValue(makeModelDoc({ scope: 'user' }));

      expect(await modelService.toggle(VALID_OID)).toBeNull();
    });

    it('returns null when model does not exist', async () => {
      (Model.findById as any).mockResolvedValue(null);
      expect(await modelService.toggle(VALID_OID)).toBeNull();
    });

    it('returns null for a malformed ObjectId without touching the DB (问题 27)', async () => {
      expect(await modelService.toggle('not-an-object-id')).toBeNull();
      expect(Model.findById).not.toHaveBeenCalled();
    });
  });

  describe('updateSortOrder', () => {
    it('T-M4: persists order and re-reads only global models', async () => {
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});
      const lean = vi.fn().mockResolvedValue([makeModelDoc()]);
      (Model.find as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean }) });

      const result = await modelService.updateSortOrder([VALID_OID_2, VALID_OID]);

      expect(Model.bulkWrite).toHaveBeenCalledWith([
        { updateOne: { filter: { _id: VALID_OID_2, scope: 'global' }, update: { sortOrder: 0 } } },
        { updateOne: { filter: { _id: VALID_OID, scope: 'global' }, update: { sortOrder: 1 } } },
      ]);
      expect(Model.find).toHaveBeenCalledWith({ _id: { $in: [VALID_OID_2, VALID_OID] }, scope: 'global' });
      expect(result).toHaveLength(1);
    });

    it('drops malformed ids instead of throwing CastError (问题 27)', async () => {
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});
      const lean = vi.fn().mockResolvedValue([]);
      (Model.find as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean }) });

      await modelService.updateSortOrder(['bad-id', VALID_OID]);

      expect(Model.bulkWrite).toHaveBeenCalledWith([
        { updateOne: { filter: { _id: VALID_OID, scope: 'global' }, update: { sortOrder: 0 } } },
      ]);
    });
  });
});
