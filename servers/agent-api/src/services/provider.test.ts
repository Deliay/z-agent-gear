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

  describe('create', () => {
    it('should create a provider and models', async () => {
      const createSpy = vi.fn().mockResolvedValue({
        _id: { toString: () => 'new-provider' },
        name: 'Test Provider',
        type: 'OpenAI',
        endpoint: 'https://api.openai.com/v1',
        credentialType: 'api_key',
        encryptedCredential: { iv: 'iv', ciphertext: 'enc', tag: 'tag' },
        isEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        toObject: vi.fn().mockReturnValue({
          _id: { toString: () => 'new-provider' },
          name: 'Test Provider',
          type: 'OpenAI',
          endpoint: 'https://api.openai.com/v1',
          credentialType: 'api_key',
          encryptedCredential: { iv: 'iv', ciphertext: 'enc', tag: 'tag' },
          isEnabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      });
      (Provider.create as any) = createSpy;
      (Model.insertMany as any) = vi.fn().mockResolvedValue([]);

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
      expect(Model.insertMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'gpt-4o', isCustom: false, scope: 'user' }),
          expect.objectContaining({ name: 'gpt-4o-mini', isCustom: false, scope: 'user' }),
        ]),
      );
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
    });

    it('should update provider with new credentialValue', async () => {
      const updateSpy = vi.fn().mockResolvedValue({
        ...mockExisting,
        name: 'Updated Provider',
        type: 'Anthropic',
        endpoint: 'https://api.anthropic.com',
      });
      (Provider.findByIdAndUpdate as any) = updateSpy;
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Model.insertMany as any) = vi.fn().mockResolvedValue([]);
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
    });

    it('should preserve existing credential when credentialValue is empty (edit without changing key)', async () => {
      const updateSpy = vi.fn().mockResolvedValue({
        ...mockExisting,
        name: 'Renamed Provider',
        endpoint: 'https://custom.openai.com/v1',
      });
      (Provider.findByIdAndUpdate as any) = updateSpy;
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Model.insertMany as any) = vi.fn().mockResolvedValue([]);
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
      expect(Model.deleteMany).toHaveBeenCalledWith({ providerId: 'provider-1' });
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
    it('keeps user-scope filters and cascades when no global provider is targeted', async () => {
      (Provider.findOne as any) = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
      });
      (Provider.updateMany as any) = vi.fn().mockResolvedValue({ modifiedCount: 0 });
      (Provider.deleteMany as any) = vi.fn().mockResolvedValue({ deletedCount: 0 });
      (Model.updateMany as any) = vi.fn().mockResolvedValue({});
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});

      const userFilter = {
        _id: { $in: ['a', 'b'] },
        $or: [{ scope: 'user' }, { scope: { $exists: false } }],
      };

      await providerService.batchEnable(['a', 'b']);
      expect(Provider.updateMany).toHaveBeenCalledWith(userFilter, { isEnabled: true });

      await providerService.batchDisable(['a', 'b']);
      expect(Provider.updateMany).toHaveBeenCalledWith(userFilter, { isEnabled: false });

      await providerService.batchDelete(['a', 'b']);
      expect(Provider.deleteMany).toHaveBeenCalledWith(userFilter);
      expect(Model.updateMany).toHaveBeenCalledWith(
        { providerId: { $in: ['a', 'b'] }, scope: { $ne: 'global' } },
        expect.any(Object),
      );
    });

    it('rejects batch operations that target a global provider (no silent skip)', async () => {
      (Provider.findOne as any) = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: 'g' }) }),
      });
      (Provider.updateMany as any) = vi.fn();
      (Provider.deleteMany as any) = vi.fn();
      (Model.updateMany as any) = vi.fn();
      (Model.deleteMany as any) = vi.fn();

      await expect(providerService.batchEnable(['a', 'g'])).rejects.toThrow('全局配置请在管理后台修改');
      await expect(providerService.batchDisable(['a', 'g'])).rejects.toThrow('全局配置请在管理后台修改');
      await expect(providerService.batchDelete(['a', 'g'])).rejects.toThrow('全局配置请在管理后台修改');

      expect(Provider.updateMany).not.toHaveBeenCalled();
      expect(Provider.deleteMany).not.toHaveBeenCalled();
      expect(Model.deleteMany).not.toHaveBeenCalled();
    });
  });
});

