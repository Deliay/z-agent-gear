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
