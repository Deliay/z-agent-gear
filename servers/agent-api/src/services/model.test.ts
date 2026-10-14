import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Model } from '../models/model.js';
import { modelService } from './model';

vi.mock('../models/model.js');

describe('ModelService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    it('should create a custom model with incremented sortOrder', async () => {
      (Model.findOne as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue({ sortOrder: 5 }),
          }),
        }),
      });

      const createSpy = vi.fn().mockResolvedValue({
        _id: { toString: () => 'model-new' },
        providerId: { toString: () => '507f1f77bcf86cd799439011' },
        name: 'custom-model',
        isCustom: true,
        isEnabled: true,
        sortOrder: 6,
        createdAt: new Date(),
        updatedAt: new Date(),
        toObject: vi.fn().mockReturnValue({
          _id: { toString: () => 'model-new' },
          providerId: { toString: () => '507f1f77bcf86cd799439011' },
          name: 'custom-model',
          isCustom: true,
          isEnabled: true,
          sortOrder: 6,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      });
      (Model.create as any) = createSpy;

      const result = await modelService.createCustom({
        providerId: '507f1f77bcf86cd799439011',
        name: 'custom-model',
      });

      expect(result.name).toBe('custom-model');
      expect(result.isCustom).toBe(true);
      expect(result.sortOrder).toBe(6);
      expect(Model.create).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'user', isCustom: true }),
      );
    });
  });

  describe('updateSortOrder', () => {
    it('should update sort order based on array order', async () => {
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});
      const leanFn2 = vi.fn().mockResolvedValue([
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
      (Model.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: leanFn2 }),
      });

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
  });

  describe('delete', () => {
    it('should delete a custom model and return it', async () => {
      const mockModel = {
        _id: 'model-custom',
        providerId: { toString: () => 'provider-1' },
        name: 'my-custom-model',
        isCustom: true,
        isEnabled: true,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        toObject: vi.fn().mockReturnValue({
          _id: { toString: () => 'model-custom' },
          providerId: { toString: () => 'provider-1' },
          name: 'my-custom-model',
          isCustom: true,
          isEnabled: true,
          sortOrder: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      };

      (Model.findById as any) = vi.fn().mockResolvedValue(mockModel);
      (Model.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      const result = await modelService.delete('model-custom');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('my-custom-model');
      expect(result!.isCustom).toBe(true);
      expect(Model.deleteOne).toHaveBeenCalledWith({ _id: 'model-custom' });
    });

    it('should return null for auto-synced model (non-custom)', async () => {
      const mockModel = {
        _id: 'model-auto',
        providerId: { toString: () => 'provider-1' },
        name: 'gpt-4o',
        isCustom: false,
        isEnabled: true,
        sortOrder: 0,
      };

      (Model.findById as any) = vi.fn().mockResolvedValue(mockModel);

      const result = await modelService.delete('model-auto');
      expect(result).toBeNull();
      expect(Model.deleteOne).not.toHaveBeenCalled();
    });

    it('should return null if model not found', async () => {
      (Model.findById as any) = vi.fn().mockResolvedValue(null);

      const result = await modelService.delete('non-existent');
      expect(result).toBeNull();
      expect(Model.deleteOne).not.toHaveBeenCalled();
    });

    it('should throw when deleting a global model', async () => {
      (Model.findById as any) = vi.fn().mockResolvedValue({
        _id: 'global-model',
        providerId: { toString: () => 'provider-g' },
        isCustom: true,
        scope: 'global',
      });
      (Model.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      await expect(modelService.delete('global-model')).rejects.toThrow('全局配置请在管理后台修改');
      expect(Model.deleteOne).not.toHaveBeenCalled();
    });
  });

  describe('toggle', () => {
    it('should toggle model isEnabled', async () => {
      const mockModel = {
        _id: 'model-1',
        providerId: { toString: () => 'provider-1' },
        isEnabled: false,
        save: vi.fn(),
        toObject: vi.fn().mockReturnValue({
          _id: { toString: () => 'model-1' },
          providerId: { toString: () => 'provider-1' },
          name: 'gpt-4o',
          isCustom: false,
          isEnabled: true,
          sortOrder: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      };

      (Model.findById as any) = vi.fn().mockResolvedValue(mockModel);
      const mockProvider = { isEnabled: true };
      const mockLean = vi.fn().mockResolvedValue(mockProvider);
      vi.spyOn(require('mongoose'), 'model').mockReturnValue({
        findById: vi.fn().mockReturnValue({ lean: mockLean }),
      });

      const result = await modelService.toggle('model-1');
      expect(result).not.toBeNull();
      expect(mockModel.save).toHaveBeenCalled();
    });

    it('should return null if provider is disabled', async () => {
      const mockModel = {
        _id: 'model-1',
        providerId: { toString: () => 'provider-1' },
        isEnabled: false,
        save: vi.fn(),
      };

      (Model.findById as any) = vi.fn().mockResolvedValue(mockModel);
      const mockProvider = { isEnabled: false };
      const mockLean = vi.fn().mockResolvedValue(mockProvider);
      vi.spyOn(require('mongoose'), 'model').mockReturnValue({
        findById: vi.fn().mockReturnValue({ lean: mockLean }),
      });

      const result = await modelService.toggle('model-1');
      expect(result).toBeNull();
    });

    it('should throw when toggling a global model', async () => {
      (Model.findById as any) = vi.fn().mockResolvedValue({
        _id: 'global-model',
        providerId: { toString: () => 'provider-g' },
        isEnabled: false,
        scope: 'global',
        save: vi.fn(),
      });

      await expect(modelService.toggle('global-model')).rejects.toThrow('全局配置请在管理后台修改');
    });
  });
});
