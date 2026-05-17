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
      expect(Model.bulkWrite).toHaveBeenCalled();
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
  });
});
