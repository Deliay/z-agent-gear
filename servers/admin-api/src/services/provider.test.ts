import { describe, it, expect, vi, beforeEach } from 'vitest';
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

    it('T-P2: creates provider and syncs models with scope=global', async () => {
      const doc = makeProviderDoc();
      (Provider.create as any) = vi.fn().mockResolvedValue({
        ...doc,
        toObject: () => doc,
      });
      (Model.insertMany as any) = vi.fn().mockResolvedValue([]);

      const result = await providerService.create(validInput);

      expect(cryptoModule.encrypt).toHaveBeenCalledWith('sk-test-key');
      expect(Provider.create).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global' }));
      expect(Model.insertMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'gpt-4o', isCustom: false, sortOrder: 0, scope: 'global' }),
          expect.objectContaining({ name: 'gpt-4o-mini', isCustom: false, sortOrder: 1, scope: 'global' }),
        ]),
      );
      expect(result.scope).toBe('global');
      expect(result.credentialValue).toContain('****');
    });

    it('rejects when name is empty', async () => {
      await expect(providerService.create({ ...validInput, name: '  ' })).rejects.toThrow('Provider name is required');
      expect(Provider.create).not.toHaveBeenCalled();
    });

    it('T-P7: propagates duplicate name error (E11000) without syncing models', async () => {
      (Provider.create as any) = vi.fn().mockRejectedValue(new Error('E11000 duplicate key error'));
      (Model.insertMany as any) = vi.fn().mockResolvedValue([]);

      await expect(providerService.create(validInput)).rejects.toThrow('E11000');
      expect(Model.insertMany).not.toHaveBeenCalled();
    });

    it('问题 54: dedupes/drops upstream model names so duplicate names cannot E11000', async () => {
      const { llmApiService } = await import('./llm-api');
      (llmApiService.fetchModels as any).mockResolvedValueOnce(['gpt-4o', 'gpt-4o', '', '   ', 'gpt-4o-mini']);
      const doc = makeProviderDoc();
      (Provider.create as any) = vi.fn().mockResolvedValue({ ...doc, toObject: () => doc });
      (Model.insertMany as any) = vi.fn().mockResolvedValue([]);
      (Provider.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      await providerService.create(validInput);

      const docs = (Model.insertMany as any).mock.calls[0][0] as Array<{ name: string; sortOrder: number }>;
      expect(docs.map((d) => d.name)).toEqual(['gpt-4o', 'gpt-4o-mini']);
      expect(docs.map((d) => d.sortOrder)).toEqual([0, 1]);
      // 去重后不再触发唯一索引冲突，也就不需要清理供应商
      expect(Provider.deleteOne).not.toHaveBeenCalled();
      expect(Model.deleteMany).not.toHaveBeenCalled();
    });

    it('问题 54: deletes the provider when model sync fails in the non-transaction path (no orphan)', async () => {
      const doc = makeProviderDoc();
      (Provider.create as any) = vi.fn().mockResolvedValue({ ...doc, toObject: () => doc });
      (Model.insertMany as any) = vi.fn().mockRejectedValue(new Error('E11000 duplicate key error'));
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Provider.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      await expect(providerService.create(validInput)).rejects.toThrow('E11000');

      expect(Model.deleteMany).toHaveBeenCalledWith({ providerId: doc._id, scope: 'global' });
      expect(Provider.deleteOne).toHaveBeenCalledWith({ _id: doc._id, scope: 'global' });
    });

    it('问题 54: skips model insert entirely when the upstream list is empty after normalization', async () => {
      const { llmApiService } = await import('./llm-api');
      (llmApiService.fetchModels as any).mockResolvedValueOnce(['', '  ']);
      const doc = makeProviderDoc();
      (Provider.create as any) = vi.fn().mockResolvedValue({ ...doc, toObject: () => doc });
      (Model.insertMany as any) = vi.fn().mockResolvedValue([]);

      await providerService.create(validInput);

      expect(Model.insertMany).not.toHaveBeenCalled();
      expect(Provider.deleteOne).not.toHaveBeenCalled();
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

    it('T-P3: preserves credential and resyncs models when endpoint changes', async () => {
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
      // 问题 48：upsert 同步模型 + 仅删除陈旧同步模型（不再 delete+insert）
      const ops = (Model.bulkWrite as any).mock.calls[0][0] as Array<{ updateOne: { filter: { name: string }; update: { $set: Record<string, unknown> }; upsert: boolean } }>;
      expect(ops.map((op) => op.updateOne.filter.name).sort()).toEqual(['gpt-4o', 'gpt-4o-mini']);
      expect(ops[0].updateOne.upsert).toBe(true);
      expect(ops[0].updateOne.update.$set).toMatchObject({ isCustom: false, scope: 'global', isEnabled: true });
      expect(Model.insertMany).not.toHaveBeenCalled();
      expect(Model.deleteMany).toHaveBeenCalledWith({
        providerId: OID,
        scope: 'global',
        isCustom: false,
        name: { $nin: ['gpt-4o', 'gpt-4o-mini'] },
      });
      expect(Provider.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: OID, scope: 'global' },
        expect.objectContaining({ endpoint: 'https://custom.openai.com/v1' }),
        { new: true, lean: true },
      );
    });

    it('T-P3: skips resync when only name changed and credential stays empty', async () => {
      (Provider.findOneAndUpdate as any) = vi.fn().mockResolvedValue(makeProviderDoc({ name: 'Renamed' }));
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      const { llmApiService } = await import('./llm-api');

      await providerService.update(OID, { ...validInput, name: 'Renamed', credentialValue: '' });

      expect(llmApiService.fetchModels).not.toHaveBeenCalled();
      expect(Model.deleteMany).not.toHaveBeenCalled();
      expect(Model.bulkWrite).not.toHaveBeenCalled();
      expect(Model.find).not.toHaveBeenCalled();
    });

    it('T-P3: encrypts a new credential and resyncs models', async () => {
      (Provider.findOneAndUpdate as any) = vi.fn().mockResolvedValue(makeProviderDoc());
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      const { llmApiService } = await import('./llm-api');

      await providerService.update(OID, validInput);

      expect(cryptoModule.encrypt).toHaveBeenCalledWith('sk-test-key');
      expect(llmApiService.fetchModels).toHaveBeenCalledWith(
        'OpenAI', 'https://api.openai.com/v1', 'sk-test-key',
      );
      expect(Model.bulkWrite).toHaveBeenCalled();
    });

    it('T-P8: keeps custom models across a resync (deleteMany filter excludes isCustom=true)', async () => {
      (Provider.findOneAndUpdate as any) = vi.fn().mockResolvedValue(makeProviderDoc());
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});

      await providerService.update(OID, validInput);

      // 只删除 API 同步模型，用户自定义模型（isCustom=true）不被级联删除（问题 5）
      expect(Model.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ isCustom: false }),
      );
      expect(Model.deleteMany).not.toHaveBeenCalledWith({ providerId: OID, scope: 'global' });
    });

    it('T-P9 (问题 48): a custom model with the same name as an API model survives resync', async () => {
      (Provider.findOneAndUpdate as any) = vi.fn().mockResolvedValue(makeProviderDoc());
      (Model.find as any) = vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ name: 'gpt-4o' }]),
      });
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});

      await expect(providerService.update(OID, validInput)).resolves.not.toBeNull();

      // 同名的 fetched 名被跳过（不覆盖自定义模型），只 upsert 余下名字
      const ops = (Model.bulkWrite as any).mock.calls[0][0] as Array<{ updateOne: { filter: { name: string } } }>;
      expect(ops.map((op) => op.updateOne.filter.name)).toEqual(['gpt-4o-mini']);

      // 陈旧同步模型删除集合也不包含该同名（其 isCustom=true 本就受 isCustom:false 过滤保护）
      expect(Model.deleteMany).toHaveBeenCalledWith({
        providerId: OID,
        scope: 'global',
        isCustom: false,
        name: { $nin: ['gpt-4o-mini'] },
      });
      // 不再走 delete+insert（避免唯一索引 E11000）
      expect(Model.insertMany).not.toHaveBeenCalled();
    });

    it('T-P9 (问题 48): upserts existing synced models and dedupes fetched names', async () => {
      const { llmApiService } = await import('./llm-api');
      (llmApiService.fetchModels as any).mockResolvedValueOnce(['gpt-4o', 'gpt-4o', 'gpt-4o-mini']);
      (Provider.findOneAndUpdate as any) = vi.fn().mockResolvedValue(makeProviderDoc());
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});

      await providerService.update(OID, validInput);

      const ops = (Model.bulkWrite as any).mock.calls[0][0] as Array<{ updateOne: { filter: { name: string } } }>;
      expect(ops.map((op) => op.updateOne.filter.name)).toEqual(['gpt-4o', 'gpt-4o-mini']);
      expect(Model.insertMany).not.toHaveBeenCalled();
    });

    it('T-P9 (问题 48): deletes all stale synced models when the API returns none', async () => {
      const { llmApiService } = await import('./llm-api');
      (llmApiService.fetchModels as any).mockResolvedValueOnce([]);
      (Provider.findOneAndUpdate as any) = vi.fn().mockResolvedValue(makeProviderDoc());
      (Model.bulkWrite as any) = vi.fn().mockResolvedValue({});
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});

      await providerService.update(OID, validInput);

      expect(Model.bulkWrite).not.toHaveBeenCalled();
      expect(Model.deleteMany).toHaveBeenCalledWith({
        providerId: OID,
        scope: 'global',
        isCustom: false,
        name: { $nin: [] },
      });
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
