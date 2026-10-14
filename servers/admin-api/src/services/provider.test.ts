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

      const result = await providerService.findById('provider-1');

      expect(Provider.findOne).toHaveBeenCalledWith({ _id: 'provider-1', scope: 'global' });
      expect(result!.id).toBe('provider-1');
    });

    it('returns null when the provider is not global', async () => {
      (Provider.findOne as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const result = await providerService.findById('user-provider');

      expect(Provider.findOne).toHaveBeenCalledWith({ _id: 'user-provider', scope: 'global' });
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('T-P1: aborts without persisting when connectivity check fails', async () => {
      const { llmApiService } = await import('./llm-api');
      (llmApiService.fetchModels as any).mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:9'));

      await expect(providerService.create(validInput)).rejects.toThrow('connect');

      expect(Provider.create).not.toHaveBeenCalled();
      expect(Model.insertMany).not.toHaveBeenCalled();
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
    });

    it('T-P3: preserves credential and resyncs models when endpoint changes', async () => {
      (Provider.findOneAndUpdate as any) = vi.fn().mockResolvedValue(
        makeProviderDoc({ endpoint: 'https://custom.openai.com/v1' }),
      );
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Model.insertMany as any) = vi.fn().mockResolvedValue([]);
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
      expect(Model.deleteMany).toHaveBeenCalledWith({ providerId: OID, scope: 'global' });
      expect(Model.insertMany).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ isCustom: false, scope: 'global' })]),
      );
      expect(Provider.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: OID, scope: 'global' },
        expect.objectContaining({ endpoint: 'https://custom.openai.com/v1' }),
        { new: true, lean: true },
      );
    });

    it('T-P3: skips resync when only name changed and credential stays empty', async () => {
      (Provider.findOneAndUpdate as any) = vi.fn().mockResolvedValue(makeProviderDoc({ name: 'Renamed' }));
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Model.insertMany as any) = vi.fn().mockResolvedValue([]);
      const { llmApiService } = await import('./llm-api');

      await providerService.update(OID, { ...validInput, name: 'Renamed', credentialValue: '' });

      expect(llmApiService.fetchModels).not.toHaveBeenCalled();
      expect(Model.deleteMany).not.toHaveBeenCalled();
      expect(Model.insertMany).not.toHaveBeenCalled();
    });

    it('T-P3: encrypts a new credential and resyncs models', async () => {
      (Provider.findOneAndUpdate as any) = vi.fn().mockResolvedValue(makeProviderDoc());
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Model.insertMany as any) = vi.fn().mockResolvedValue([]);
      const { llmApiService } = await import('./llm-api');

      await providerService.update(OID, validInput);

      expect(cryptoModule.encrypt).toHaveBeenCalledWith('sk-test-key');
      expect(llmApiService.fetchModels).toHaveBeenCalledWith(
        'OpenAI', 'https://api.openai.com/v1', 'sk-test-key',
      );
      expect(Model.deleteMany).toHaveBeenCalledWith({ providerId: OID, scope: 'global' });
    });

    it('returns null when the provider is not global', async () => {
      (Provider.findOne as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const result = await providerService.update('missing', validInput);

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('T-P4: cascades model deletion with scope=global', async () => {
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Provider.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      const result = await providerService.delete('provider-1');

      expect(result).toBe(true);
      expect(Model.deleteMany).toHaveBeenCalledWith({ providerId: 'provider-1', scope: 'global' });
      expect(Provider.deleteOne).toHaveBeenCalledWith({ _id: 'provider-1', scope: 'global' });
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

      const result = await providerService.toggle('provider-1');

      expect(result).not.toBeNull();
      expect(doc.isEnabled).toBe(true);
      expect(doc.save).toHaveBeenCalledTimes(1);
      expect(Model.updateMany).toHaveBeenCalledWith(
        { providerId: 'provider-1', scope: 'global' },
        { isEnabled: true },
      );
    });

    it('returns null when provider is not found in global scope', async () => {
      (Provider.findOne as any).mockResolvedValue(null);

      expect(await providerService.toggle('missing')).toBeNull();
    });
  });

  describe('batch operations', () => {
    it('T-P6: batchEnable filters by global scope and cascades to models', async () => {
      (Provider.updateMany as any) = vi.fn().mockResolvedValue({ modifiedCount: 2 });
      (Model.updateMany as any) = vi.fn().mockResolvedValue({});

      const result = await providerService.batchEnable(['p1', 'p2']);

      expect(result).toEqual({ successCount: 2 });
      expect(Provider.updateMany).toHaveBeenCalledWith(
        { _id: { $in: ['p1', 'p2'] }, scope: 'global' },
        { isEnabled: true },
      );
      expect(Model.updateMany).toHaveBeenCalledWith(
        { providerId: { $in: ['p1', 'p2'] }, scope: 'global' },
        { isEnabled: true },
      );
    });

    it('T-P6: batchDisable filters by global scope and cascades to models', async () => {
      (Provider.updateMany as any) = vi.fn().mockResolvedValue({ modifiedCount: 1 });
      (Model.updateMany as any) = vi.fn().mockResolvedValue({});

      const result = await providerService.batchDisable(['p1']);

      expect(result).toEqual({ successCount: 1 });
      expect(Provider.updateMany).toHaveBeenCalledWith(
        { _id: { $in: ['p1'] }, scope: 'global' },
        { isEnabled: false },
      );
      expect(Model.updateMany).toHaveBeenCalledWith(
        { providerId: { $in: ['p1'] }, scope: 'global' },
        { isEnabled: false },
      );
    });

    it('T-P6: batchDelete deletes global providers and their models', async () => {
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Provider.deleteMany as any) = vi.fn().mockResolvedValue({ deletedCount: 3 });

      const result = await providerService.batchDelete(['p1', 'p2', 'p3']);

      expect(result).toEqual({ successCount: 3 });
      expect(Model.deleteMany).toHaveBeenCalledWith({ providerId: { $in: ['p1', 'p2', 'p3'] }, scope: 'global' });
      expect(Provider.deleteMany).toHaveBeenCalledWith({ _id: { $in: ['p1', 'p2', 'p3'] }, scope: 'global' });
    });
  });
});
