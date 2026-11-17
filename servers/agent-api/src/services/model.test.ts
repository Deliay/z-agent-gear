import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Model } from '../models/model.js';
import { Provider } from '../models/provider.js';
import { modelService } from './model';

vi.mock('../models/model.js');
vi.mock('../models/provider.js', () => ({
  Provider: { findOne: vi.fn() },
}));

vi.mock('./crypto', () => ({
  decrypt: vi.fn().mockReturnValue('sk-decrypted-key'),
}));

vi.mock('./llm-api', () => ({
  llmApiService: {
    fetchModelCatalog: vi.fn(),
  },
}));

const USER_PROVIDER_OID = '507f1f77bcf86cd799439011';

function mockProviderScope(scope: 'user' | 'global' | null) {
  (Provider.findOne as any).mockReturnValue({
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(scope ? { scope } : null),
    }),
  });
}

/** 带上游连接信息的供应商（自动补全链路用）。 */
function mockProviderConnection(doc: Record<string, unknown> | null) {
  (Provider.findOne as any).mockReturnValue({
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(doc),
    }),
  });
}

function createdModelDoc(overrides: Record<string, unknown> = {}) {
  const doc = {
    _id: { toString: () => 'model-new' },
    providerId: { toString: () => USER_PROVIDER_OID },
    name: 'custom-model',
    isCustom: true,
    isEnabled: true,
    sortOrder: 6,
    scope: 'user',
    contextLength: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  return { ...doc, toObject: () => doc };
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

    it('persists an explicit contextLength', async () => {
      (Model.create as any) = vi.fn().mockResolvedValue(createdModelDoc({ contextLength: 200000 }));

      await modelService.createCustom({
        providerId: USER_PROVIDER_OID,
        name: 'custom-model',
        contextLength: 200000,
      });

      expect(Model.create).toHaveBeenCalledWith(
        expect.objectContaining({ contextLength: 200000 }),
      );
    });

    it('rejects an invalid explicit contextLength before any DB write', async () => {
      (Model.create as any) = vi.fn();
      await expect(
        modelService.createCustom({
          providerId: USER_PROVIDER_OID,
          name: 'custom-model',
          contextLength: 0,
        }),
      ).rejects.toThrow('contextLength must be a positive integer');
      expect(Model.create).not.toHaveBeenCalled();
      expect(Provider.findOne).not.toHaveBeenCalled();
    });

    it('does not call the upstream when contextLength is explicitly null (user cleared it)', async () => {
      const { llmApiService } = await import('./llm-api');
      (Model.create as any) = vi.fn().mockResolvedValue(createdModelDoc({ contextLength: null }));

      await modelService.createCustom({
        providerId: USER_PROVIDER_OID,
        name: 'custom-model',
        contextLength: null,
      });

      expect(llmApiService.fetchModelCatalog).not.toHaveBeenCalled();
      expect(Model.create).toHaveBeenCalledWith(
        expect.objectContaining({ contextLength: null }),
      );
    });

    it('best-effort fills contextLength from the upstream when omitted (match)', async () => {
      const { llmApiService } = await import('./llm-api');
      mockProviderConnection({
        scope: 'user',
        type: 'OpenAI',
        endpoint: 'https://api.openai.com/v1',
        encryptedCredential: { iv: 'iv', ciphertext: 'enc', tag: 'tag' },
      });
      (llmApiService.fetchModelCatalog as any).mockResolvedValue([
        { name: 'other-model', contextLength: 8000 },
        { name: 'custom-model', contextLength: 128000 },
      ]);
      (Model.create as any) = vi.fn().mockResolvedValue(createdModelDoc({ contextLength: 128000 }));

      await modelService.createCustom({ providerId: USER_PROVIDER_OID, name: 'custom-model' });

      expect(llmApiService.fetchModelCatalog).toHaveBeenCalledWith(
        'OpenAI',
        'https://api.openai.com/v1',
        'sk-decrypted-key',
      );
      expect(Model.create).toHaveBeenCalledWith(
        expect.objectContaining({ contextLength: 128000 }),
      );
    });

    it('keeps contextLength unset when the upstream has no matching entry', async () => {
      const { llmApiService } = await import('./llm-api');
      mockProviderConnection({
        scope: 'user',
        type: 'OpenAI',
        endpoint: 'https://api.openai.com/v1',
        encryptedCredential: { iv: 'iv', ciphertext: 'enc', tag: 'tag' },
      });
      (llmApiService.fetchModelCatalog as any).mockResolvedValue([
        { name: 'other-model', contextLength: 8000 },
      ]);
      (Model.create as any) = vi.fn().mockResolvedValue(createdModelDoc());

      await modelService.createCustom({ providerId: USER_PROVIDER_OID, name: 'custom-model' });

      expect(Model.create).toHaveBeenCalledWith(
        expect.objectContaining({ contextLength: null }),
      );
    });

    it('does not block creation when the upstream lookup throws', async () => {
      const { llmApiService } = await import('./llm-api');
      mockProviderConnection({
        scope: 'user',
        type: 'OpenAI',
        endpoint: 'https://api.openai.com/v1',
        encryptedCredential: { iv: 'iv', ciphertext: 'enc', tag: 'tag' },
      });
      (llmApiService.fetchModelCatalog as any).mockRejectedValue(new Error('timeout'));
      (Model.create as any) = vi.fn().mockResolvedValue(createdModelDoc());

      await expect(
        modelService.createCustom({ providerId: USER_PROVIDER_OID, name: 'custom-model' }),
      ).resolves.toMatchObject({ name: 'custom-model' });
      expect(Model.create).toHaveBeenCalledWith(
        expect.objectContaining({ contextLength: null }),
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

  describe('updateContextLength（T-UMC2）', () => {
    const MODEL_OID = '507f1f77bcf86cd7994390aa';

    function mappedDoc(contextLength: number | null) {
      return {
        _id: { toString: () => MODEL_OID },
        providerId: { toString: () => USER_PROVIDER_OID },
        name: 'custom-model',
        isCustom: true,
        isEnabled: true,
        sortOrder: 0,
        scope: 'user',
        contextLength,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    it('writes a positive integer through findOneAndUpdate (user-scope filter)', async () => {
      (Model.findOneAndUpdate as any) = vi.fn().mockResolvedValue(mappedDoc(128000));

      const result = await modelService.updateContextLength(MODEL_OID, 128000);

      expect(Model.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: MODEL_OID, scope: { $ne: 'global' } },
        { $set: { contextLength: 128000 } },
        { returnDocument: 'after', lean: true },
      );
      expect(result.contextLength).toBe(128000);
    });

    it('clears the value when null is passed', async () => {
      (Model.findOneAndUpdate as any) = vi.fn().mockResolvedValue(mappedDoc(null));

      const result = await modelService.updateContextLength(MODEL_OID, null);

      expect(Model.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: MODEL_OID, scope: { $ne: 'global' } },
        { $set: { contextLength: null } },
        { returnDocument: 'after', lean: true },
      );
      expect(result.contextLength).toBeNull();
    });

    it.each([0, -1, 1.5, '128000', Number.NaN])(
      'rejects invalid value %s with the shared message',
      async (value) => {
        (Model.findOneAndUpdate as any) = vi.fn();
        await expect(
          modelService.updateContextLength(MODEL_OID, value),
        ).rejects.toThrow('contextLength must be a positive integer');
        expect(Model.findOneAndUpdate).not.toHaveBeenCalled();
      },
    );

    it('rejects malformed ids without touching the DB', async () => {
      (Model.findOneAndUpdate as any) = vi.fn();
      await expect(
        modelService.updateContextLength('not-an-object-id', 1000),
      ).rejects.toThrow('Model not found');
      expect(Model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('maps global / other-workspace / missing rows (empty match) to Model not found', async () => {
      (Model.findOneAndUpdate as any) = vi.fn().mockResolvedValue(null);

      await expect(
        modelService.updateContextLength(MODEL_OID, 1000),
      ).rejects.toThrow('Model not found');
      // 写插件把过滤收敛到当前工作区；global 由 scope 条件排除 → 未命中即不泄露存在性
      expect(Model.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: MODEL_OID, scope: { $ne: 'global' } },
        { $set: { contextLength: 1000 } },
        { returnDocument: 'after', lean: true },
      );
    });
  });
});

describe('ModelService.listSourceLibrary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-SS2: 只 select name/scope，scope 归一为 user/global', async () => {
    const selectFn = vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([
        { name: 'gpt-4o', scope: 'global' },
        { name: 'my-model', scope: 'user' },
        { name: 'legacy-model' },
      ]),
    });
    (Model.find as any).mockReturnValue({ select: selectFn });

    const library = await modelService.listSourceLibrary();

    expect(selectFn).toHaveBeenCalledWith('name scope');
    expect(library).toEqual([
      { name: 'gpt-4o', scope: 'global' },
      { name: 'my-model', scope: 'user' },
      { name: 'legacy-model', scope: 'user' },
    ]);
  });
});
