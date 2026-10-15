import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modelResolvers } from './model.js';

vi.mock('../../services/model.js', () => ({
  modelService: {
    findAll: vi.fn(),
    findByProviderId: vi.fn(),
    createCustom: vi.fn(),
    delete: vi.fn(),
    toggle: vi.fn(),
    updateSortOrder: vi.fn(),
  },
}));

vi.mock('../../services/provider.js', () => ({
  providerService: { findSummaryById: vi.fn() },
}));

import { modelService } from '../../services/model.js';
import { providerService } from '../../services/provider.js';

const mockContext = { currentUser: { id: 'user1', username: 'testuser' } };

const Model = modelResolvers.Model as { provider: (parent: { providerId: string }) => Promise<unknown> };

describe('modelResolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Model.provider', () => {
    it('delegates to providerService.findSummaryById (never the credential-bearing findById)', async () => {
      (providerService.findSummaryById as any).mockResolvedValue({
        id: 'p1',
        name: 'Global OpenAI',
        type: 'OpenAI',
        isEnabled: true,
        scope: 'global',
      });

      const result = await Model.provider({ providerId: 'p1' });

      expect(providerService.findSummaryById).toHaveBeenCalledWith('p1');
      expect(result).toEqual({
        id: 'p1',
        name: 'Global OpenAI',
        type: 'OpenAI',
        isEnabled: true,
        scope: 'global',
      });
    });

    it('does not expose endpoint / credential fields on the returned provider summary', async () => {
      (providerService.findSummaryById as any).mockResolvedValue({
        id: 'p1',
        name: 'Global OpenAI',
        type: 'OpenAI',
        isEnabled: true,
        scope: 'global',
      });

      const result = (await Model.provider({ providerId: 'p1' })) as Record<string, unknown>;

      expect(result).not.toHaveProperty('endpoint');
      expect(result).not.toHaveProperty('credentialType');
      expect(result).not.toHaveProperty('credentialValue');
      expect(result).not.toHaveProperty('encryptedCredential');
    });

    it('returns null when the provider is missing', async () => {
      (providerService.findSummaryById as any).mockResolvedValue(null);
      await expect(Model.provider({ providerId: 'missing' })).resolves.toBeNull();
    });
  });

  describe('query guard (sanity)', () => {
    it('rejects anonymous models query', async () => {
      await expect(
        (modelResolvers.Query as any).models({}, {}, { currentUser: null }),
      ).rejects.toThrow('Not authenticated');
    });

    it('delegates models query when authenticated', async () => {
      (modelService.findAll as any).mockResolvedValue([{ id: 'm1' }]);
      await expect(
        (modelResolvers.Query as any).models({}, {}, mockContext),
      ).resolves.toEqual([{ id: 'm1' }]);
    });
  });
});
