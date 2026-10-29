import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Provider } from '../models/provider.js';
import { Model } from '../models/model.js';
import { providerService } from './provider';
import { llmApiService } from './llm-api';
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

function makeProviderDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'provider-1' },
    name: 'Global OpenAI',
    type: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    credentialType: 'api_key',
    encryptedCredential: { iv: 'iv', ciphertext: 'enc', tag: 'tag' },
    isEnabled: true,
    scope: 'global',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

const validInput = {
  name: 'Global OpenAI',
  type: 'OpenAI' as const,
  endpoint: 'https://api.openai.com/v1',
  credentialType: 'api_key',
  credentialValue: 'sk-test-key',
};

// 合法 24 位 hex ObjectId（问题 27：非法 ObjectId 视为不存在）
const PROVIDER_OID = '507f1f77bcf86cd799439011';
const OTHER_OID = '507f191e810c19729de860ea';
const MISSING_OID = '000000000000000000000000';

describe('ProviderService (admin / global scope)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findAll', () => {
    it('queries only scope=global and maps provider', async () => {
      const lean = vi.fn().mockResolvedValue([makeProviderDoc()]);
      (Provider.find as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean }) });

      const result = await providerService.findAll();

      expect(Provider.find).toHaveBeenCalledWith({ scope: 'global' });
      expect(result).toHaveLength(1);
      expect(result[0].scope).toBe('global');
      expect(result[0].credentialValue).toContain('****');
    });
  });

  describe('findById', () => {
    it('adds scope=global to the lookup and maps result', async () => {
      (Provider.findOne as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(makeProviderDoc()) });

      const result = await providerService.findById(PROVIDER_OID);

      expect(Provider.findOne).toHaveBeenCalledWith({ _id: PROVIDER_OID, scope: 'global' });
      expect(result!.id).toBe('provider-1');
    });

    it('returns null when the provider is not global', async () => {
      (Provider.findOne as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const result = await providerService.findById(PROVIDER_OID);

      expect(Provider.findOne).toHaveBeenCalledWith({ _id: PROVIDER_OID, scope: 'global' });
      expect(result).toBeNull();
    });

    it('returns null for a malformed ObjectId without touching the DB (问题 27)', async () => {
      const result = await providerService.findById('not-an-object-id');

      expect(result).toBeNull();
      expect(Provider.findOne).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('T-P1: aborts without persisting when connectivity check fails (realistic SDK error)', async () => {
      const { llmApiService } = await import('./llm-api');
      // 贴近 openai/@anthropic SDK 的真实失败形态，而非从未出现的 'connect ECONNREFUSED'
      (llmApiService.fetchModels as any).mockRejectedValueOnce(new Error('Connection error.'));

      await expect(providerService.create(validInput)).rejects.toThrow(
        '供应商连通性测试失败，请检查 API 地址和凭据是否正确',
      );

      expect(Provider.create).not.toHaveBeenCalled();
      expect(Model.insertMany).not.toHaveBeenCalled();
    });

    it('T-P1: also normalizes credential (401) failures to the connectivity message', async () => {
      const { llmApiService } = await import('./llm-api');
      (llmApiService.fetchModels as any).mockRejectedValueOnce(new Error('401 Incorrect API key provided'));

      await expect(providerService.create(validInput)).rejects.toThrow(
        '供应商连通性测试失败，请检查 API 地址和凭据是否正确',
      );
      expect(Provider.create).not.toHaveBeenCalled();
    });

    it('U-P1/T-P2: creates a provider without importing any models', async () => {
      const doc = makeProviderDoc();
      (Provider.create as any) = vi.fn().mockResolvedValue({
        ...doc,
        toObject: () => doc,
      });
      (Model.insertMany as any) = vi.fn().mockResolvedValue([]);

      const result = await providerService.create(validInput);

      expect(cryptoModule.encrypt).toHaveBeenCalledWith('sk-test-key');
      expect(Provider.create).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global' }));
      // 后台改为手动导入：创建供应商只做连通性校验，不写模型
      expect(llmApiService.fetchModels).toHaveBeenCalledTimes(1);
      expect(Model.insertMany).not.toHaveBeenCalled();
      expect(Model.create).not.toHaveBeenCalled();
      expect(Model.bulkWrite).not.toHaveBeenCalled();
      expect(result.scope).toBe('global');
      expect(result.credentialValue).toContain('****');
    });

    it('rejects when name is empty', async () => {
      await expect(providerService.create({ ...validInput, name: '  ' })).rejects.toThrow('Provider name is required');
      expect(Provider.create).not.toHaveBeenCalled();
    });

    it('T-P7: propagates duplicate name error (E11000) without writing models', async () => {
      (Provider.create as any) = vi.fn().mockRejectedValue(new Error('E11000 duplicate key error'));
      (Model.insertMany as any) = vi.fn().mockResolvedValue([]);

      await expect(providerService.create(validInput)).rejects.toThrow('E11000');
      expect(Model.insertMany).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const OID = '507f1f77bcf86cd799439011';
    const existing = {
      _id: OID,
      type: 'OpenAI',
      endpoint: 'https://api.openai.com/v1',
      encryptedCredential: { iv: 'old-iv', ciphertext: 'old-enc', tag: 'old-tag' },
    };

    beforeEach(() => {
      (Provider.findOne as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(existing) });
      // 问题 48：重同步前读取保留的自定义模型名。默认无自定义模型。
      (Model.find as any) = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    });

    it('U-P3/T-P3: preserves credential, validates connectivity but never resyncs models when endpoint changes', async () => {
      (Provider.findOneAndUpdate as any) = vi.fn().mockResolvedValue(
        makeProviderDoc({ endpoint: 'https://custom.openai.com/v1' }),
      );
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      const { llmApiService } = await import('./llm-api');

      const result = await providerService.update(OID, {
        ...validInput,
        endpoint: 'https://custom.openai.com/v1',
        credentialValue: '',
      });

      expect(result).not.toBeNull();
      expect(cryptoModule.encrypt).not.toHaveBeenCalled();
      expect(cryptoModule.decrypt).toHaveBeenCalledWith(existing.encryptedCredential);
      expect(llmApiService.fetchModels).toHaveBeenCalledWith(
        'OpenAI', 'https://custom.openai.com/v1', 'sk-proj-decrypted-key',
      );
      // 后台取消自动重同步：只校验连通性，不写模型
      expect(Model.bulkWrite).not.toHaveBeenCalled();
      expect(Model.deleteMany).not.toHaveBeenCalled();
      expect(Model.find).not.toHaveBeenCalled();
      expect(Model.insertMany).not.toHaveBeenCalled();
      expect(Provider.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: OID, scope: 'global' },
        expect.objectContaining({ endpoint: 'https://custom.openai.com/v1' }),
        { returnDocument: 'after', lean: true },
      );
    });

    it('U-P4/T-P3: skips the connectivity check when only the name changed', async () => {
      (Provider.findOneAndUpdate as any) = vi.fn().mockResolvedValue(makeProviderDoc({ name: 'Renamed' }));
      const { llmApiService } = await import('./llm-api');

      await providerService.update(OID, { ...validInput, name: 'Renamed', credentialValue: '' });

      expect(llmApiService.fetchModels).not.toHaveBeenCalled();
      expect(Model.deleteMany).not.toHaveBeenCalled();
      expect(Model.bulkWrite).not.toHaveBeenCalled();
      expect(Model.find).not.toHaveBeenCalled();
    });

    it('U-P3: encrypts a new credential, validates connectivity and leaves models untouched', async () => {
      (Provider.findOneAndUpdate as any) = vi.fn().mockResolvedValue(makeProviderDoc());
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});

      await providerService.update(OID, validInput);

      expect(cryptoModule.encrypt).toHaveBeenCalledWith('sk-test-key');
      expect(llmApiService.fetchModels).toHaveBeenCalledWith(
        'OpenAI', 'https://api.openai.com/v1', 'sk-test-key',
      );
      expect(Model.bulkWrite).not.toHaveBeenCalled();
      expect(Model.deleteMany).not.toHaveBeenCalled();
    });

    it('rejects an empty name like create (问题 21)', async () => {
      await expect(providerService.update(OID, { ...validInput, name: '  ' })).rejects.toThrow('Provider name is required');
      expect(Provider.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('returns null for a malformed id without touching the DB (问题 27)', async () => {
      const result = await providerService.update('not-an-object-id', validInput);

      expect(result).toBeNull();
      expect(Provider.findOne).not.toHaveBeenCalled();
      expect(Provider.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('returns null when the provider is not global', async () => {
      (Provider.findOne as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const result = await providerService.update(OTHER_OID, validInput);

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('T-P4: cascades model deletion with scope=global', async () => {
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Provider.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      const result = await providerService.delete(PROVIDER_OID);

      expect(result).toBe(true);
      expect(Model.deleteMany).toHaveBeenCalledWith({ providerId: PROVIDER_OID, scope: 'global' });
      expect(Provider.deleteOne).toHaveBeenCalledWith({ _id: PROVIDER_OID, scope: 'global' });
    });

    it('returns false for a malformed id without touching the DB (问题 27)', async () => {
      const result = await providerService.delete('not-an-object-id');

      expect(result).toBe(false);
      expect(Model.deleteMany).not.toHaveBeenCalled();
      expect(Provider.deleteOne).not.toHaveBeenCalled();
    });
  });

  describe('toggle', () => {
    it('T-P5: flips isEnabled and cascades to global models', async () => {
      const doc = {
        ...makeProviderDoc({ isEnabled: false }),
        save: vi.fn().mockResolvedValue(undefined),
        toObject: () => makeProviderDoc({ isEnabled: true }),
      };
      (Provider.findOne as any).mockResolvedValue(doc);
      (Model.updateMany as any) = vi.fn().mockResolvedValue({});

      const result = await providerService.toggle(PROVIDER_OID);

      expect(result).not.toBeNull();
      expect(doc.isEnabled).toBe(true);
      expect(doc.save).toHaveBeenCalledTimes(1);
      expect(Model.updateMany).toHaveBeenCalledWith(
        { providerId: PROVIDER_OID, scope: 'global' },
        { isEnabled: true },
      );
    });

    it('returns null when provider is not found in global scope', async () => {
      (Provider.findOne as any).mockResolvedValue(null);

      expect(await providerService.toggle(MISSING_OID)).toBeNull();
    });

    it('returns null for a malformed id without touching the DB (问题 27)', async () => {
      const result = await providerService.toggle('not-an-object-id');

      expect(result).toBeNull();
      expect(Provider.findOne).not.toHaveBeenCalled();
    });
  });

  describe('batch operations', () => {
    const SECOND_OID = '507f1f77bcf86cd799439012';
    const THIRD_OID = '507f1f77bcf86cd799439013';

    it('T-P6: batchEnable filters by global scope and cascades to models', async () => {
      (Provider.updateMany as any) = vi.fn().mockResolvedValue({ modifiedCount: 2 });
      (Model.updateMany as any) = vi.fn().mockResolvedValue({});

      const result = await providerService.batchEnable([PROVIDER_OID, OTHER_OID]);

      expect(result).toEqual({ successCount: 2 });
      expect(Provider.updateMany).toHaveBeenCalledWith(
        { _id: { $in: [PROVIDER_OID, OTHER_OID] }, scope: 'global' },
        { isEnabled: true },
      );
      expect(Model.updateMany).toHaveBeenCalledWith(
        { providerId: { $in: [PROVIDER_OID, OTHER_OID] }, scope: 'global' },
        { isEnabled: true },
      );
    });

    it('T-P6: batchDisable filters by global scope and cascades to models', async () => {
      (Provider.updateMany as any) = vi.fn().mockResolvedValue({ modifiedCount: 1 });
      (Model.updateMany as any) = vi.fn().mockResolvedValue({});

      const result = await providerService.batchDisable([PROVIDER_OID]);

      expect(result).toEqual({ successCount: 1 });
      expect(Provider.updateMany).toHaveBeenCalledWith(
        { _id: { $in: [PROVIDER_OID] }, scope: 'global' },
        { isEnabled: false },
      );
      expect(Model.updateMany).toHaveBeenCalledWith(
        { providerId: { $in: [PROVIDER_OID] }, scope: 'global' },
        { isEnabled: false },
      );
    });

    it('T-P6: batchDelete deletes global providers and their models', async () => {
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Provider.deleteMany as any) = vi.fn().mockResolvedValue({ deletedCount: 3 });

      const result = await providerService.batchDelete([PROVIDER_OID, OTHER_OID, SECOND_OID]);

      expect(result).toEqual({ successCount: 3 });
      expect(Model.deleteMany).toHaveBeenCalledWith({ providerId: { $in: [PROVIDER_OID, OTHER_OID, SECOND_OID] }, scope: 'global' });
      expect(Provider.deleteMany).toHaveBeenCalledWith({ _id: { $in: [PROVIDER_OID, OTHER_OID, SECOND_OID] }, scope: 'global' });
    });

    it('问题 55: batchEnable/Disable/Delete drop invalid ObjectIds instead of raising CastError', async () => {
      (Provider.updateMany as any) = vi.fn().mockResolvedValue({ modifiedCount: 1 });
      (Model.updateMany as any) = vi.fn().mockResolvedValue({});
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Provider.deleteMany as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      // 混合合法/非法 id：非法项被过滤，仅合法 id 进入 $in
      await providerService.batchEnable([PROVIDER_OID, 'not-an-object-id', SECOND_OID]);
      expect(Provider.updateMany).toHaveBeenCalledWith(
        { _id: { $in: [PROVIDER_OID, SECOND_OID] }, scope: 'global' },
        { isEnabled: true },
      );

      await providerService.batchDisable([OTHER_OID, 'also-bad']);
      expect(Provider.updateMany).toHaveBeenLastCalledWith(
        { _id: { $in: [OTHER_OID] }, scope: 'global' },
        { isEnabled: false },
      );

      await providerService.batchDelete([THIRD_OID, 'nope']);
      expect(Model.deleteMany).toHaveBeenCalledWith({ providerId: { $in: [THIRD_OID] }, scope: 'global' });
      expect(Provider.deleteMany).toHaveBeenCalledWith({ _id: { $in: [THIRD_OID] }, scope: 'global' });
    });

    it('问题 55: batch operations short-circuit to successCount 0 when no id is a valid ObjectId', async () => {
      (Provider.updateMany as any) = vi.fn();
      (Model.updateMany as any) = vi.fn();
      (Model.deleteMany as any) = vi.fn();
      (Provider.deleteMany as any) = vi.fn();

      await expect(providerService.batchEnable(['bad', 'worse'])).resolves.toEqual({ successCount: 0 });
      await expect(providerService.batchDisable(['bad'])).resolves.toEqual({ successCount: 0 });
      await expect(providerService.batchDelete(['bad', 'worse'])).resolves.toEqual({ successCount: 0 });

      expect(Provider.updateMany).not.toHaveBeenCalled();
      expect(Model.updateMany).not.toHaveBeenCalled();
      expect(Model.deleteMany).not.toHaveBeenCalled();
      expect(Provider.deleteMany).not.toHaveBeenCalled();
    });
  });
});
