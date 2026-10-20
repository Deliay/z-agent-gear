import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Provider } from '../models/provider.js';
import { Model } from '../models/model.js';
import { providerService } from './provider';
import * as cryptoModule from './crypto';

vi.mock('../models/provider.js');
vi.mock('../models/model.js');
vi.mock('./llm-api', () => ({
  llmApiService: {
    fetchModels: vi.fn().mockResolvedValue(['gpt-4o', 'gpt-4o-mini']),
  },
}));

vi.mock('./crypto', () => ({
  encrypt: vi.fn().mockReturnValue({ iv: 'iv', ciphertext: 'encrypted', tag: 'tag' }),
  decrypt: vi.fn().mockReturnValue('sk-proj-decrypted-key'),
}));

describe('ProviderService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findAll', () => {
    it('should return all providers mapped correctly', async () => {
      const mockProviders = [
        {
          _id: { toString: () => 'provider-1' },
          name: 'My OpenAI',
          type: 'OpenAI',
          endpoint: 'https://api.openai.com/v1',
          credentialType: 'api_key',
          encryptedCredential: { iv: 'iv', ciphertext: 'enc', tag: 'tag' },
          isEnabled: true,
          scope: 'user',
          createdAt: new Date('2026-01-01'),
          updatedAt: new Date('2026-01-01'),
        },
      ];
      const leanFn = vi.fn().mockResolvedValue(mockProviders);
      (Provider.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: leanFn }),
      });

      const result = await providerService.findAll();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('My OpenAI');
      expect(result[0].credentialValue).toContain('****');
      expect(result[0].scope).toBe('user');
    });

    it('should query only user-scope providers (including legacy docs without scope)', async () => {
      const findSpy = vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      });
      (Provider.find as any) = findSpy;

      await providerService.findAll();

      expect(findSpy).toHaveBeenCalledWith({
        $or: [{ scope: 'user' }, { scope: { $exists: false } }],
      });
    });

    it('should default scope to user when field is absent (legacy data)', async () => {
      const leanFn = vi.fn().mockResolvedValue([
        {
          _id: { toString: () => 'legacy-1' },
          name: 'Legacy',
          type: 'OpenAI',
          endpoint: 'https://api.openai.com/v1',
          credentialType: 'api_key',
          encryptedCredential: { iv: 'iv', ciphertext: 'enc', tag: 'tag' },
          isEnabled: true,
          createdAt: new Date('2026-01-01'),
          updatedAt: new Date('2026-01-01'),
        },
      ]);
      (Provider.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: leanFn }),
      });

      const result = await providerService.findAll();
      expect(result[0].scope).toBe('user');
    });
  });

  describe('findSummaryById (Model.provider projection)', () => {
    it('selects away encryptedCredential and omits endpoint/credential fields', async () => {
      const selectSpy = vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: { toString: () => 'p-summary' },
          name: 'User OpenAI',
          type: 'OpenAI',
          endpoint: 'https://internal.example.com/v1',
          credentialType: 'api_key',
          isEnabled: true,
          scope: 'user',
        }),
      });
      (Provider.findById as any) = vi.fn().mockReturnValue({ select: selectSpy });

      const result = await providerService.findSummaryById('p-summary');

      expect(Provider.findById).toHaveBeenCalledWith('p-summary');
      expect(selectSpy).toHaveBeenCalledWith('-encryptedCredential');
      expect(result).toEqual({
        id: 'p-summary',
        name: 'User OpenAI',
        type: 'OpenAI',
        isEnabled: true,
        scope: 'user',
      });
      expect(result).not.toHaveProperty('endpoint');
      expect(result).not.toHaveProperty('credentialType');
      expect(result).not.toHaveProperty('credentialValue');
    });

    it('never returns a summary for a global (backend) provider', async () => {
      (Provider.findById as any) = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({
            _id: { toString: () => 'p-global' },
            name: 'Backend OpenAI',
            type: 'OpenAI',
            isEnabled: true,
            scope: 'global',
          }),
        }),
      });

      await expect(providerService.findSummaryById('p-global')).resolves.toBeNull();
    });

    it('returns null when the provider does not exist', async () => {
      (Provider.findById as any) = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
      });

      await expect(providerService.findSummaryById('missing')).resolves.toBeNull();
    });
  });

  describe('create', () => {
    const NEW_OID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439099');

    function mockProviderCreated() {
      const doc = {
        _id: NEW_OID,
        name: 'Test Provider',
        type: 'OpenAI',
        endpoint: 'https://api.openai.com/v1',
        credentialType: 'api_key',
        encryptedCredential: { iv: 'iv', ciphertext: 'enc', tag: 'tag' },
        isEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      (Provider.create as any) = vi.fn().mockResolvedValue({
        ...doc,
        toObject: vi.fn().mockReturnValue(doc),
      });
    }

    beforeEach(() => {
      mockProviderCreated();
      (Model.find as any) = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      });
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Model.insertMany as any) = vi.fn().mockResolvedValue([]);
      (Provider.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });
    });

    function bulkNames(): string[] {
      const ops = (Model.bulkWrite as any).mock.calls[0][0] as Array<{
        updateOne: { filter: { name: string } };
      }>;
      return ops.map((op) => op.updateOne.filter.name);
    }

    it('should create a provider and sync models via upsert (shared with resync)', async () => {
      const result = await providerService.create({
        name: 'Test Provider',
        type: 'OpenAI',
        endpoint: 'https://api.openai.com/v1',
        credentialType: 'api_key',
        credentialValue: 'sk-test-key',
      });

      expect(result.name).toBe('Test Provider');
      expect(cryptoModule.encrypt).toHaveBeenCalledWith('sk-test-key');
      expect(Provider.create).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'user' }),
      );
      // 问题 54：create 与 resync 共用同一套 upsert/skip-custom 逻辑，不再 insertMany
      expect(Model.insertMany).not.toHaveBeenCalled();
      expect(bulkNames()).toEqual(['gpt-4o', 'gpt-4o-mini']);
      expect(Model.bulkWrite).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            updateOne: expect.objectContaining({
              update: expect.objectContaining({
                $set: expect.objectContaining({ isCustom: false, isEnabled: true, scope: 'user' }),
              }),
              upsert: true,
            }),
          }),
        ]),
      );
    });

    it('dedupes duplicate upstream model names so insert cannot hit the unique index (issue 54)', async () => {
      const { llmApiService } = await import('./llm-api');
      (llmApiService.fetchModels as any).mockResolvedValueOnce([
        'gpt-4o',
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4o',
        'gpt-4o-mini',
      ]);

      const result = await providerService.create({
        name: 'Test Provider',
        type: 'OpenAI',
        endpoint: 'https://api.openai.com/v1',
        credentialType: 'api_key',
        credentialValue: 'sk-test-key',
      });

      expect(result.name).toBe('Test Provider');
      const names = bulkNames();
      // 每个名字只 upsert 一次，重复名不再触发 (providerId,name) 唯一索引 E11000
      expect(names).toEqual(['gpt-4o', 'gpt-4o-mini']);
      expect(new Set(names).size).toBe(names.length);
      // provider 未被回滚删除
      expect(Provider.deleteOne).not.toHaveBeenCalled();
    });

    it('skips empty upstream model names before syncing', async () => {
      const { llmApiService } = await import('./llm-api');
      (llmApiService.fetchModels as any).mockResolvedValueOnce([
        'gpt-4o',
        '',
        '   ',
        'gpt-4o-mini',
      ]);

      await providerService.create({
        name: 'Test Provider',
        type: 'OpenAI',
        endpoint: 'https://api.openai.com/v1',
        credentialType: 'api_key',
        credentialValue: 'sk-test-key',
      });

      expect(bulkNames()).toEqual(['gpt-4o', 'gpt-4o-mini']);
    });

    it('rolls back the created provider when model sync fails (no orphan, best effort)', async () => {
      (Model.bulkWrite as any) = vi.fn().mockRejectedValue(new Error('write failed'));

      await expect(providerService.create({
        name: 'Test Provider',
        type: 'OpenAI',
        endpoint: 'https://api.openai.com/v1',
        credentialType: 'api_key',
        credentialValue: 'sk-test-key',
      })).rejects.toThrow('write failed');

      // 清理已写入的模型 + 删除刚创建的供应商，避免孤儿记录
      expect(Model.deleteMany).toHaveBeenCalledWith({
        providerId: NEW_OID,
        scope: { $ne: 'global' },
      });
      expect(Provider.deleteOne).toHaveBeenCalledWith({ _id: NEW_OID });
    });
  });

  describe('update', () => {
    const VALID_OID = '507f1f77bcf86cd799439011';
    const mockExisting = {
      _id: { toString: () => VALID_OID },
      name: 'Existing Provider',
      type: 'OpenAI',
      endpoint: 'https://api.openai.com/v1',
      credentialType: 'api_key',
      encryptedCredential: { iv: 'old-iv', ciphertext: 'old-enc', tag: 'old-tag' },
      isEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      (Provider.findById as any) = vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockExisting),
      });
      // 默认无自定义模型同名冲突（问题 48 去重前的既有行为）
      (Model.find as any) = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      });
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Model.insertMany as any) = vi.fn().mockResolvedValue([]);
    });

    it('should update provider with new credentialValue', async () => {
      const updateSpy = vi.fn().mockResolvedValue({
        ...mockExisting,
        name: 'Updated Provider',
        type: 'Anthropic',
        endpoint: 'https://api.anthropic.com',
      });
      (Provider.findByIdAndUpdate as any) = updateSpy;
      const { llmApiService } = await import('./llm-api');

      const result = await providerService.update(VALID_OID, {
        name: 'Updated Provider',
        type: 'Anthropic',
        endpoint: 'https://api.anthropic.com',
        credentialType: 'api_key',
        credentialValue: 'sk-new-key',
      });

      expect(result).not.toBeNull();
      expect(result!.name).toBe('Updated Provider');
      expect(cryptoModule.encrypt).toHaveBeenCalledWith('sk-new-key');
      expect(llmApiService.fetchModels).toHaveBeenCalledWith(
        'Anthropic', 'https://api.anthropic.com', 'sk-new-key',
      );
      // 问题 48：重同步改为按 (providerId,name) upsert，不再 delete+insert
      expect(Model.bulkWrite).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            updateOne: expect.objectContaining({
              filter: expect.objectContaining({ name: 'gpt-4o' }),
              update: expect.objectContaining({
                $set: expect.objectContaining({ isCustom: false, isEnabled: true, scope: 'user' }),
              }),
              upsert: true,
            }),
          }),
        ]),
      );
      expect(Model.insertMany).not.toHaveBeenCalled();
      // 只删除不在期望集合内的自动同步模型（保留自定义 / 全局）
      expect(Model.deleteMany).toHaveBeenCalledWith({
        providerId: VALID_OID,
        isCustom: false,
        scope: { $ne: 'global' },
        name: { $nin: ['gpt-4o', 'gpt-4o-mini'] },
      });
      // provider 写入先于模型同步（provider 写失败不打挂模型）
      expect(updateSpy.mock.invocationCallOrder[0]).toBeLessThan(
        (Model.bulkWrite as any).mock.invocationCallOrder[0],
      );
    });

    it('should preserve existing credential when credentialValue is empty (edit without changing key)', async () => {
      const updateSpy = vi.fn().mockResolvedValue({
        ...mockExisting,
        name: 'Renamed Provider',
        endpoint: 'https://custom.openai.com/v1',
      });
      (Provider.findByIdAndUpdate as any) = updateSpy;
      const { llmApiService } = await import('./llm-api');

      const result = await providerService.update(VALID_OID, {
        name: 'Renamed Provider',
        type: 'OpenAI',
        endpoint: 'https://custom.openai.com/v1',
        credentialType: 'api_key',
        credentialValue: '',
      });

      expect(result).not.toBeNull();
      expect(result!.name).toBe('Renamed Provider');
      expect(cryptoModule.encrypt).not.toHaveBeenCalled();
      expect(llmApiService.fetchModels).toHaveBeenCalledWith(
        'OpenAI', 'https://custom.openai.com/v1', 'sk-proj-decrypted-key',
      );
    });

    it('skips fetched API models colliding with a preserved custom model (no E11000, no data loss)', async () => {
      (Provider.findByIdAndUpdate as any) = vi.fn().mockResolvedValue({
        ...mockExisting,
        name: 'Renamed Provider',
        endpoint: 'https://custom.openai.com/v1',
      });
      const bulkWrite = vi.fn().mockResolvedValue({});
      (Model.bulkWrite as any) = bulkWrite;
      // provider 下存在与 API 模型同名的自定义模型 `gpt-4o`
      const findLean = vi.fn().mockResolvedValue([{ name: 'gpt-4o' }]);
      (Model.find as any) = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: findLean }),
      });

      const result = await providerService.update(VALID_OID, {
        name: 'Renamed Provider',
        type: 'OpenAI',
        endpoint: 'https://custom.openai.com/v1',
        credentialType: 'api_key',
        credentialValue: '',
      });

      expect(result).not.toBeNull();
      // 加载自定义模型名时带 scope 过滤，避免误读全局模型
      expect(Model.find).toHaveBeenCalledWith({
        providerId: VALID_OID,
        isCustom: true,
        scope: { $ne: 'global' },
      });
      // 同名 `gpt-4o` 被跳过，只 upsert 其余 API 模型
      const ops = bulkWrite.mock.calls[0][0] as Array<{ updateOne: { filter: { name: string } } }>;
      const names = ops.map((op) => op.updateOne.filter.name);
      expect(names).toEqual(['gpt-4o-mini']);
      expect(names).not.toContain('gpt-4o');
      // 自定义模型不会被删除（deleteMany 仅作用于 isCustom:false）
      expect(Model.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ isCustom: false }),
      );
      expect(Model.insertMany).not.toHaveBeenCalled();
    });

    it('writes the provider before syncing models so a failed provider write keeps models intact', async () => {
      (Provider.findByIdAndUpdate as any) = vi.fn().mockResolvedValue(null);

      const result = await providerService.update(VALID_OID, {
        name: 'Renamed Provider',
        type: 'OpenAI',
        endpoint: 'https://custom.openai.com/v1',
        credentialType: 'api_key',
        credentialValue: '',
      });

      expect(result).toBeNull();
      expect(Model.bulkWrite).not.toHaveBeenCalled();
      expect(Model.deleteMany).not.toHaveBeenCalled();
      expect(Model.insertMany).not.toHaveBeenCalled();
    });

    it('is idempotent: repeated resync upserts instead of rebuilding models', async () => {
      (Provider.findByIdAndUpdate as any) = vi.fn().mockResolvedValue({ ...mockExisting });
      const input = {
        name: 'Existing Provider',
        type: 'OpenAI' as const,
        endpoint: 'https://custom.openai.com/v1',
        credentialType: 'api_key',
        credentialValue: '',
      };

      await providerService.update(VALID_OID, input);
      await providerService.update(VALID_OID, input);

      expect(Model.bulkWrite).toHaveBeenCalledTimes(2);
      expect(Model.insertMany).not.toHaveBeenCalled();
    });

    it('scopes resync upserts to non-custom models (isCustom:{$ne:true}) to close the TOCTOU window (建议 I)', async () => {
      (Provider.findByIdAndUpdate as any) = vi.fn().mockResolvedValue({ ...mockExisting });
      const bulkWrite = vi.fn().mockResolvedValue({});
      (Model.bulkWrite as any) = bulkWrite;

      await providerService.update(VALID_OID, {
        name: 'Existing Provider',
        type: 'OpenAI' as const,
        endpoint: 'https://custom.openai.com/v1',
        credentialType: 'api_key',
        credentialValue: '',
      });

      const ops = bulkWrite.mock.calls[0][0] as Array<{
        updateOne: { filter: Record<string, unknown> };
      }>;
      expect(ops.length).toBeGreaterThan(0);
      for (const op of ops) {
        // 即便读自定义模型后、upsert 前被并发插入同名自定义模型，也不会被覆盖为同步模型
        expect(op.updateOne.filter.isCustom).toEqual({ $ne: true });
      }
    });

    it('rejects an empty or whitespace name before any DB write (建议 I)', async () => {
      await expect(providerService.update(VALID_OID, {
        name: '   ',
        type: 'OpenAI' as const,
        endpoint: 'https://api.openai.com/v1',
        credentialType: 'api_key',
        credentialValue: 'sk-x',
      })).rejects.toThrow('Provider name is required');

      expect(Provider.findById).not.toHaveBeenCalled();
      expect(Provider.findByIdAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('update scope guard', () => {
    const GLOBAL_OID = '507f1f77bcf86cd799439022';
    it('should throw when updating a global provider', async () => {
      (Provider.findById as any) = vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ scope: 'global', encryptedCredential: { iv: 'i', ciphertext: 'c', tag: 't' }, type: 'OpenAI', endpoint: 'https://api.openai.com/v1' }),
      });

      await expect(providerService.update(GLOBAL_OID, {
        name: 'x',
        type: 'OpenAI',
        endpoint: 'https://api.openai.com/v1',
        credentialType: 'api_key',
        credentialValue: 'sk-x',
      })).rejects.toThrow('全局配置请在管理后台修改');
      expect(Provider.findByIdAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('toggle', () => {
    it('should toggle isEnabled and cascade to models', async () => {
      const mockProvider = {
        _id: 'provider-1',
        isEnabled: false,
        save: vi.fn(),
        toObject: vi.fn().mockReturnValue({
          _id: { toString: () => 'provider-1' },
          name: 'Test Provider',
          type: 'OpenAI',
          endpoint: 'https://api.openai.com/v1',
          credentialType: 'api_key',
          encryptedCredential: { iv: 'iv', ciphertext: 'enc', tag: 'tag' },
          isEnabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      };
      (Provider.findById as any) = vi.fn().mockResolvedValue(mockProvider);
      (Model.updateMany as any) = vi.fn().mockResolvedValue({});

      const result = await providerService.toggle('provider-1');
      expect(result).not.toBeNull();
      expect(mockProvider.save).toHaveBeenCalled();
      expect(Model.updateMany).toHaveBeenCalledWith(
        { providerId: 'provider-1', scope: { $ne: 'global' } },
        { isEnabled: true },
      );
    });

    it('should return null if provider not found', async () => {
      (Provider.findById as any) = vi.fn().mockResolvedValue(null);
      (Model.updateMany as any) = vi.fn().mockResolvedValue({});
      const result = await providerService.toggle('nonexistent');
      expect(result).toBeNull();
    });

    it('should throw when toggling a global provider', async () => {
      (Provider.findById as any) = vi.fn().mockResolvedValue({
        _id: 'g', scope: 'global', isEnabled: false, save: vi.fn(),
      });
      (Model.updateMany as any) = vi.fn().mockResolvedValue({});

      await expect(providerService.toggle('g')).rejects.toThrow('全局配置请在管理后台修改');
      expect(Model.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should delete provider and cascade models', async () => {
      (Provider.findById as any) = vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'provider-1', scope: 'user' }),
      });
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Provider.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      const result = await providerService.delete('provider-1');
      expect(result).toBe(true);
      expect(Model.deleteMany).toHaveBeenCalledWith({
        providerId: 'provider-1',
        scope: { $ne: 'global' },
      });
    });

    it('should treat legacy providers without scope as user and delete them', async () => {
      (Provider.findById as any) = vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'legacy', encryptedCredential: { iv: 'i', ciphertext: 'c', tag: 't' } }),
      });
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Provider.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      const result = await providerService.delete('legacy');
      expect(result).toBe(true);
    });

    it('should return false when provider does not exist', async () => {
      (Provider.findById as any) = vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });
      (Provider.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 0 });

      const result = await providerService.delete('nonexistent');
      expect(result).toBe(false);
      expect(Model.deleteMany).not.toHaveBeenCalled();
    });

    it('should throw when deleting a global provider', async () => {
      (Provider.findById as any) = vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'g', scope: 'global' }),
      });
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Provider.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      await expect(providerService.delete('g')).rejects.toThrow('全局配置请在管理后台修改');
      expect(Model.deleteMany).not.toHaveBeenCalled();
      expect(Provider.deleteOne).not.toHaveBeenCalled();
    });
  });

  describe('batch operations scope guard', () => {
    // 合法 24 位十六进制 ObjectId；'a'/'b' 之类非法 id 会被过滤（建议 E）
    const ID_A = '507f1f77bcf86cd7994390aa';
    const ID_B = '507f1f77bcf86cd7994390bb';
    const ID_GLOBAL = '507f1f77bcf86cd7994390cc';

    it('keeps user-scope filters and cascades when no global provider is targeted', async () => {
      (Provider.findOne as any) = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
      });
      (Provider.updateMany as any) = vi.fn().mockResolvedValue({ modifiedCount: 0 });
      (Provider.deleteMany as any) = vi.fn().mockResolvedValue({ deletedCount: 0 });
      (Model.updateMany as any) = vi.fn().mockResolvedValue({});
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});

      const userFilter = {
        _id: { $in: [ID_A, ID_B] },
        $or: [{ scope: 'user' }, { scope: { $exists: false } }],
      };

      await providerService.batchEnable([ID_A, ID_B]);
      expect(Provider.updateMany).toHaveBeenCalledWith(userFilter, { isEnabled: true });

      await providerService.batchDisable([ID_A, ID_B]);
      expect(Provider.updateMany).toHaveBeenCalledWith(userFilter, { isEnabled: false });

      await providerService.batchDelete([ID_A, ID_B]);
      expect(Provider.deleteMany).toHaveBeenCalledWith(userFilter);
      expect(Model.updateMany).toHaveBeenCalledWith(
        { providerId: { $in: [ID_A, ID_B] }, scope: { $ne: 'global' } },
        expect.any(Object),
      );
    });

    it('rejects batch operations that target a global provider (no silent skip)', async () => {
      (Provider.findOne as any) = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: ID_GLOBAL }) }),
      });
      (Provider.updateMany as any) = vi.fn();
      (Provider.deleteMany as any) = vi.fn();
      (Model.updateMany as any) = vi.fn();
      (Model.deleteMany as any) = vi.fn();

      await expect(providerService.batchEnable([ID_A, ID_GLOBAL])).rejects.toThrow('全局配置请在管理后台修改');
      await expect(providerService.batchDisable([ID_A, ID_GLOBAL])).rejects.toThrow('全局配置请在管理后台修改');
      await expect(providerService.batchDelete([ID_A, ID_GLOBAL])).rejects.toThrow('全局配置请在管理后台修改');

      expect(Provider.updateMany).not.toHaveBeenCalled();
      expect(Provider.deleteMany).not.toHaveBeenCalled();
      expect(Model.deleteMany).not.toHaveBeenCalled();
    });

    it('filters invalid ObjectIds before hitting the DB (建议 E)', async () => {
      (Provider.findOne as any) = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
      });
      (Provider.updateMany as any) = vi.fn().mockResolvedValue({ modifiedCount: 1 });
      (Provider.deleteMany as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });
      (Model.updateMany as any) = vi.fn().mockResolvedValue({});
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});

      await providerService.batchEnable([ID_A, 'not-an-object-id', '']);
      expect(Provider.updateMany).toHaveBeenCalledWith(
        { _id: { $in: [ID_A] }, $or: [{ scope: 'user' }, { scope: { $exists: false } }] },
        { isEnabled: true },
      );
      expect(Provider.findOne).toHaveBeenCalledWith({ _id: { $in: [ID_A] }, scope: 'global' });

      await providerService.batchDisable([ID_B, 'bad']);
      expect(Provider.updateMany).toHaveBeenLastCalledWith(
        { _id: { $in: [ID_B] }, $or: [{ scope: 'user' }, { scope: { $exists: false } }] },
        { isEnabled: false },
      );

      await providerService.batchDelete([ID_A, 'bad']);
      expect(Provider.deleteMany).toHaveBeenCalledWith(
        { _id: { $in: [ID_A] }, $or: [{ scope: 'user' }, { scope: { $exists: false } }] },
      );
    });

    it('returns successCount 0 for an all-invalid id list without touching the DB', async () => {
      (Provider.findOne as any) = vi.fn();
      (Provider.updateMany as any) = vi.fn();
      (Provider.deleteMany as any) = vi.fn();
      (Model.updateMany as any) = vi.fn();
      (Model.deleteMany as any) = vi.fn();

      await expect(providerService.batchEnable(['bad', 'worse'])).resolves.toEqual({ successCount: 0 });
      await expect(providerService.batchDisable(['bad'])).resolves.toEqual({ successCount: 0 });
      await expect(providerService.batchDelete(['bad'])).resolves.toEqual({ successCount: 0 });

      expect(Provider.findOne).not.toHaveBeenCalled();
      expect(Provider.updateMany).not.toHaveBeenCalled();
      expect(Provider.deleteMany).not.toHaveBeenCalled();
    });
  });
});

