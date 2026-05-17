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
      expect(Model.insertMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'gpt-4o', isCustom: false }),
          expect.objectContaining({ name: 'gpt-4o-mini', isCustom: false }),
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
  });

  describe('delete', () => {
    it('should delete provider and cascade models', async () => {
      (Model.deleteMany as any) = vi.fn().mockResolvedValue({});
      (Provider.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      const result = await providerService.delete('provider-1');
      expect(result).toBe(true);
      expect(Model.deleteMany).toHaveBeenCalledWith({ providerId: 'provider-1' });
    });
  });
});
