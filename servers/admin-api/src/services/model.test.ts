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
    insertMany: vi.fn(),
    deleteOne: vi.fn(),
    bulkWrite: vi.fn(),
  },
}));

vi.mock('../models/provider.js', () => ({
  Provider: {
    findOne: vi.fn(),
  },
}));

vi.mock('./llm-api', () => ({
  llmApiService: {
    fetchModels: vi.fn(),
  },
}));

vi.mock('./provider', () => ({
  PROVIDER_CONNECTIVITY_ERROR: '供应商连通性测试失败，请检查 API 地址和凭据是否正确',
  providerService: {
    getDecryptedConnection: vi.fn(),
  },
}));

import { Model } from '../models/model.js';
import { Provider } from '../models/provider.js';
import { llmApiService } from './llm-api';
import { providerService } from './provider';
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
    // 默认：无同名全局模型（assertNamesAvailable 通过）
    (Model.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    (llmApiService.fetchModels as any).mockResolvedValue(['gpt-4o', 'claude', 'gpt-4o']);
    (providerService.getDecryptedConnection as any).mockResolvedValue({
      type: 'OpenAI',
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-key',
    });
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

    it('U-M10: deletes a synced (non-custom) global model too', async () => {
      const doc = makeModelDoc({ isCustom: false });
      (Model.findById as any).mockResolvedValue({ ...doc, toObject: () => doc });
      (Model.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      const result = await modelService.delete(VALID_OID);

      expect(result).not.toBeNull();
      expect(Model.deleteOne).toHaveBeenCalledWith({ _id: VALID_OID });
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

describe('ModelService manual import / global name uniqueness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (Provider.findOne as any).mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: VALID_OID, scope: 'global' }) });
    (Model.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    (llmApiService.fetchModels as any).mockResolvedValue(['gpt-4o', 'claude', 'gpt-4o']);
    (providerService.getDecryptedConnection as any).mockResolvedValue({
      type: 'OpenAI',
      endpoint: 'https://api.openai.com/v1',
      apiKey: 'sk-key',
    });
    (Model.findOne as any).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ sortOrder: 2 }) }),
      }),
    });
  });

  it('U-M2: assertNamesAvailable resolves when no global conflict exists', async () => {
    await expect(modelService.assertNamesAvailable(['gpt-4o'])).resolves.toBeUndefined();
    expect(Model.find).toHaveBeenCalledWith({ scope: 'global', name: { $in: ['gpt-4o'] } }, 'name');
  });

  it('U-M1: createCustom rejects a cross-provider duplicate without writing', async () => {
    (Model.create as any) = vi.fn();
    (Model.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue([{ name: 'gpt-4o' }]) });

    await expect(
      modelService.createCustom({ providerId: VALID_OID, name: 'gpt-4o' }),
    ).rejects.toThrow('Model name already exists: gpt-4o');
    expect(Model.create).not.toHaveBeenCalled();
  });

  it('U-M3: listProviderModels keeps upstream order and marks imported / duplicate names', async () => {
    (Model.find as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue([
        { providerId: VALID_OID, name: 'gpt-4o' },
        { providerId: VALID_OID_2, name: 'claude' },
      ]),
    });

    const result = await modelService.listProviderModels(VALID_OID);

    expect(result).toEqual([
      { name: 'gpt-4o', isImported: true, isDuplicate: false },
      { name: 'claude', isImported: false, isDuplicate: true },
    ]);
    expect(llmApiService.fetchModels).toHaveBeenCalledWith('OpenAI', 'https://api.openai.com/v1', 'sk-key');
  });

  it('U-M4: listProviderModels normalizes upstream connectivity failures', async () => {
    (llmApiService.fetchModels as any).mockRejectedValue(new Error('Connection error.'));

    await expect(modelService.listProviderModels(VALID_OID)).rejects.toThrow(
      '供应商连通性测试失败，请检查 API 地址和凭据是否正确',
    );
  });

  it('U-M5: importModels inserts only the missing names with consecutive sortOrder', async () => {
    // 第一次查「该供应商已存在名」；后续 assertNamesAvailable 查全局冲突 → 无冲突
    (Model.find as any).mockReturnValueOnce({
      lean: vi.fn().mockResolvedValue([{ name: 'gpt-4o' }]),
    });
    (Model.insertMany as any).mockImplementation((docs: Array<Record<string, unknown>>) =>
      Promise.resolve(docs.map((doc, i) => ({
        ...doc,
        _id: { toString: () => `new-${i}` },
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      }))),
    );

    const result = await modelService.importModels(VALID_OID, ['gpt-4o', 'claude', ' gemini ']);

    const docs = (Model.insertMany as any).mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(docs.map((d) => d.name)).toEqual(['claude', 'gemini']);
    expect(docs.map((d) => d.sortOrder)).toEqual([3, 4]);
    expect(docs.every((d) => d.scope === 'global' && d.isCustom === false)).toBe(true);
    expect((Model.insertMany as any).mock.calls[0][1]).toEqual({ ordered: false });
    expect(result).toHaveLength(2);
  });

  it('U-M6: importModels returns [] without touching upstream when everything is already imported', async () => {
    (Model.find as any).mockReturnValue({
      lean: vi.fn().mockResolvedValue([{ name: 'gpt-4o' }]),
    });

    await expect(modelService.importModels(VALID_OID, ['gpt-4o'])).resolves.toEqual([]);
    expect(llmApiService.fetchModels).not.toHaveBeenCalled();
    expect(Model.insertMany).not.toHaveBeenCalled();
  });

  it('U-M7: importModels rejects a global duplicate without writing', async () => {
    (Model.find as any)
      // 第一次：本供应商已存在名（无）
      .mockReturnValueOnce({ lean: vi.fn().mockResolvedValue([]) })
      // 第二次：全局重名冲突
      .mockReturnValueOnce({ lean: vi.fn().mockResolvedValue([{ name: 'claude' }]) });

    await expect(modelService.importModels(VALID_OID, ['claude'])).rejects.toThrow(
      'Model name already exists: claude',
    );
    expect(Model.insertMany).not.toHaveBeenCalled();
  });

  it('U-M8: importModels rejects empty names before calling upstream', async () => {
    await expect(modelService.importModels(VALID_OID, ['  ', 'gpt-4o'])).rejects.toThrow('Model name is invalid');
    expect(llmApiService.fetchModels).not.toHaveBeenCalled();
  });

  it('U-M9: importModels maps concurrent E11000 to the duplicate-name message', async () => {
    (Model.insertMany as any).mockRejectedValue(new Error('E11000 duplicate key error'));

    await expect(modelService.importModels(VALID_OID, ['claude'])).rejects.toThrow('Model name already exists');
  });

  it('U-M11: importModels rejects an unknown provider', async () => {
    (Provider.findOne as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

    await expect(modelService.importModels(VALID_OID, ['claude'])).rejects.toThrow('Provider not found');
  });
});
