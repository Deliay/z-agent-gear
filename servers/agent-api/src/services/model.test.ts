import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Model } from '../models/model.js';
import { Provider } from '../models/provider.js';
import { modelService } from './model';

vi.mock('../models/model.js');
vi.mock('../models/provider.js', () => ({
  Provider: { findOne: vi.fn() },
}));

const USER_PROVIDER_OID = '507f1f77bcf86cd799439011';

function mockProviderScope(scope: 'user' | 'global' | null) {
  (Provider.findOne as any).mockReturnValue({
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(scope ? { scope } : null),
    }),
  });
}

describe('ModelService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认：目标供应商存在且为 user scope
    mockProviderScope('user');
  });

  describe('findAll', () => {
    it('should return all models sorted by sortOrder', async () => {
      const mockModels = [
        {
          _id: { toString: () => 'model-1' },
          providerId: { toString: () => 'provider-1' },
          name: 'gpt-4o',
          isCustom: false,
          isEnabled: true,
          sortOrder: 0,
          scope: 'user',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      const leanFn = vi.fn().mockResolvedValue(mockModels);
      (Model.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: leanFn }),
      });

      const result = await modelService.findAll();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('gpt-4o');
      expect(result[0].scope).toBe('user');
    });

    it('should query user models plus enabled global models', async () => {
      const findSpy = vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      });
      (Model.find as any) = findSpy;

      await modelService.findAll();

      expect(findSpy).toHaveBeenCalledWith({
        $or: [
          { scope: 'user' },
          { scope: { $exists: false } },
          { scope: 'global', isEnabled: true },
        ],
      });
    });

    it('should default scope to user when field is absent (legacy data)', async () => {
      const leanFn = vi.fn().mockResolvedValue([
        {
          _id: { toString: () => 'legacy' },
          providerId: { toString: () => 'provider-1' },
          name: 'legacy-model',
          isCustom: false,
          isEnabled: true,
          sortOrder: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      (Model.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: leanFn }),
      });

      const result = await modelService.findAll();
      expect(result[0].scope).toBe('user');
    });
  });

  describe('findByProviderId', () => {
    it('should combine providerId with the scope union filter', async () => {
      const findSpy = vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      });
      (Model.find as any) = findSpy;

      await modelService.findByProviderId('provider-1');

      expect(findSpy).toHaveBeenCalledWith({
        providerId: 'provider-1',
        $or: [
          { scope: 'user' },
          { scope: { $exists: false } },
          { scope: 'global', isEnabled: true },
        ],
      });
    });
  });

  describe('createCustom', () => {
    beforeEach(() => {
      (Model.findOne as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue({ sortOrder: 5 }),
          }),
        }),
      });
    });

    it('should create a custom model with incremented sortOrder', async () => {
      const doc = {
        _id: { toString: () => 'model-new' },
        providerId: { toString: () => USER_PROVIDER_OID },
        name: 'custom-model',
        isCustom: true,
        isEnabled: true,
        sortOrder: 6,
        scope: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      (Model.create as any) = vi.fn().mockResolvedValue({ ...doc, toObject: () => doc });

      const result = await modelService.createCustom({ providerId: USER_PROVIDER_OID, name: 'custom-model' });

      expect(result.name).toBe('custom-model');
      expect(result.isCustom).toBe(true);
      expect(result.sortOrder).toBe(6);
      expect(Model.create).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'user', isCustom: true }),
      );
    });

    it('rejects when the target provider is a global provider (cross-scope guard)', async () => {
      mockProviderScope('global');

      await expect(
        modelService.createCustom({ providerId: USER_PROVIDER_OID, name: 'x' }),
      ).rejects.toThrow('全局配置请在管理后台修改');
      expect(Model.create).not.toHaveBeenCalled();
    });

    it('rejects when the target provider is missing', async () => {
      mockProviderScope(null);

      await expect(
        modelService.createCustom({ providerId: USER_PROVIDER_OID, name: 'x' }),
      ).rejects.toThrow('Provider not found');
      expect(Model.create).not.toHaveBeenCalled();
    });

    it('rejects a malformed providerId', async () => {
      await expect(
        modelService.createCustom({ providerId: 'not-an-object-id', name: 'x' }),
      ).rejects.toThrow('Provider not found');
      expect(Model.create).not.toHaveBeenCalled();
    });

    it('rejects an empty name', async () => {
      await expect(
        modelService.createCustom({ providerId: USER_PROVIDER_OID, name: '' }),
      ).rejects.toThrow('Model name is required');
      expect(Model.create).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only name', async () => {
      await expect(
        modelService.createCustom({ providerId: USER_PROVIDER_OID, name: '   ' }),
      ).rejects.toThrow('Model name is required');
      expect(Model.create).not.toHaveBeenCalled();
    });

    it('trims the model name before persisting', async () => {
      const doc = {
        _id: { toString: () => 'model-trim' },
        providerId: { toString: () => USER_PROVIDER_OID },
        name: 'trimmed-model',
        isCustom: true,
        isEnabled: true,
        sortOrder: 6,
        scope: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      (Model.create as any) = vi.fn().mockResolvedValue({ ...doc, toObject: () => doc });

      await modelService.createCustom({ providerId: USER_PROVIDER_OID, name: '  trimmed-model  ' });

      expect(Model.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'trimmed-model' }),
      );
    });
  });

  describe('updateSortOrder', () => {
    it('should update sort order based on array order', async () => {
      (Model.findOne as any) = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
      });
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});

      const existenceLean = vi.fn().mockResolvedValue([{ _id: 'model-2' }, { _id: 'model-1' }]);
      const finalLean = vi.fn().mockResolvedValue([
        {
          _id: { toString: () => 'model-2' },
          providerId: { toString: () => 'provider-1' },
          name: 'gpt-4o-mini',
          isCustom: false,
          isEnabled: true,
          sortOrder: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      (Model.find as any) = vi.fn()
        .mockReturnValueOnce({ select: vi.fn().mockReturnValue({ lean: existenceLean }) })
        .mockReturnValueOnce({ sort: vi.fn().mockReturnValue({ lean: finalLean }) });

      const result = await modelService.updateSortOrder(['model-2', 'model-1']);
      expect(result).toHaveLength(1);
      expect(Model.bulkWrite).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            updateOne: expect.objectContaining({
              filter: { _id: 'model-2', scope: { $ne: 'global' } },
            }),
          }),
        ]),
      );
      expect(Model.find).toHaveBeenCalledWith({
        _id: { $in: ['model-2', 'model-1'] },
        scope: { $ne: 'global' },
      });
    });

    it('returns an empty array for an empty id list without touching the DB', async () => {
      (Model.findOne as any) = vi.fn();
      (Model.find as any) = vi.fn();
      (Model.bulkWrite as any) = vi.fn();

      await expect(modelService.updateSortOrder([])).resolves.toEqual([]);
      expect(Model.findOne).not.toHaveBeenCalled();
      expect(Model.find).not.toHaveBeenCalled();
      expect(Model.bulkWrite).not.toHaveBeenCalled();
    });

    it('rejects duplicate ids', async () => {
      (Model.findOne as any) = vi.fn();
      (Model.find as any) = vi.fn();
      (Model.bulkWrite as any) = vi.fn();

      await expect(modelService.updateSortOrder(['model-1', 'model-1'])).rejects.toThrow(
        'Duplicate model ids in sort order',
      );
      expect(Model.bulkWrite).not.toHaveBeenCalled();
    });

    it('rejects when one or more ids do not exist', async () => {
      (Model.findOne as any) = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
      });
      const existenceLean = vi.fn().mockResolvedValue([{ _id: 'model-1' }]);
      (Model.find as any) = vi.fn().mockReturnValueOnce({
        select: vi.fn().mockReturnValue({ lean: existenceLean }),
      });
      (Model.bulkWrite as any) = vi.fn();

      await expect(modelService.updateSortOrder(['model-1', 'model-missing'])).rejects.toThrow(
        'One or more models not found',
      );
      expect(Model.bulkWrite).not.toHaveBeenCalled();
    });

    it('rejects when the list contains a global model', async () => {
      (Model.findOne as any) = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: 'global-1' }) }),
      });

      await expect(modelService.updateSortOrder(['global-1'])).rejects.toThrow('全局配置请在管理后台修改');
      expect(Model.bulkWrite).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should delete a custom model and return it', async () => {
      const doc = {
        _id: 'model-custom',
        providerId: { toString: () => 'provider-1' },
        name: 'my-custom-model',
        isCustom: true,
        isEnabled: true,
        sortOrder: 0,
        scope: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (Model.findById as any) = vi.fn().mockResolvedValue({ ...doc, toObject: () => doc });
      (Model.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      const result = await modelService.delete('model-custom');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('my-custom-model');
      expect(result!.isCustom).toBe(true);
      expect(Model.deleteOne).toHaveBeenCalledWith({ _id: 'model-custom' });
    });

    it('should return null for auto-synced model (non-custom)', async () => {
      (Model.findById as any) = vi.fn().mockResolvedValue({
        _id: 'model-auto', providerId: { toString: () => 'provider-1' }, name: 'gpt-4o', isCustom: false, isEnabled: true, sortOrder: 0, scope: 'user',
      });

      expect(await modelService.delete('model-auto')).toBeNull();
      expect(Model.deleteOne).not.toHaveBeenCalled();
    });

    it('should return null if model not found', async () => {
      (Model.findById as any) = vi.fn().mockResolvedValue(null);

      expect(await modelService.delete('non-existent')).toBeNull();
      expect(Model.deleteOne).not.toHaveBeenCalled();
    });

    it('should throw when deleting a global model', async () => {
      (Model.findById as any) = vi.fn().mockResolvedValue({
        _id: 'global-model', providerId: { toString: () => 'provider-g' }, isCustom: true, scope: 'global',
      });
      (Model.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      await expect(modelService.delete('global-model')).rejects.toThrow('全局配置请在管理后台修改');
      expect(Model.deleteOne).not.toHaveBeenCalled();
    });
  });

  describe('toggle', () => {
    it('should toggle model isEnabled when the provider is enabled', async () => {
      const mockModel = {
        _id: 'model-1',
        providerId: { toString: () => 'provider-1' },
        isEnabled: false,
        scope: 'user',
        save: vi.fn(),
        toObject: vi.fn().mockReturnValue({
          _id: { toString: () => 'model-1' },
          providerId: { toString: () => 'provider-1' },
          name: 'gpt-4o',
          isCustom: false,
          isEnabled: true,
          sortOrder: 0,
          scope: 'user',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      };

      (Model.findById as any) = vi.fn().mockResolvedValue(mockModel);
      (Provider.findOne as any).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ isEnabled: true }),
      });

      const result = await modelService.toggle('model-1');
      expect(result).not.toBeNull();
      expect(mockModel.save).toHaveBeenCalled();
    });

    it('should return null if provider is disabled', async () => {
      (Model.findById as any) = vi.fn().mockResolvedValue({
        _id: 'model-1', providerId: { toString: () => 'provider-1' }, isEnabled: false, scope: 'user', save: vi.fn(),
      });
      (Provider.findOne as any).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ isEnabled: false }),
      });

      expect(await modelService.toggle('model-1')).toBeNull();
    });

    it('should throw when toggling a global model', async () => {
      (Model.findById as any) = vi.fn().mockResolvedValue({
        _id: 'global-model', providerId: { toString: () => 'provider-g' }, isEnabled: false, scope: 'global', save: vi.fn(),
      });

      await expect(modelService.toggle('global-model')).rejects.toThrow('全局配置请在管理后台修改');
    });
  });
});
