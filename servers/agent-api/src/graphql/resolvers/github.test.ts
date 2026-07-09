import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/github.js', () => ({
  githubService: {
    getAccounts: vi.fn(),
    getAppUrl: vi.fn(),
    unbindAccount: vi.fn(),
    refreshInstallations: vi.fn(),
  },
}));

import { githubService } from '../../services/github.js';
import { githubResolvers } from './github.js';

const mockContext = {
  currentUser: { id: 'user1', username: 'testuser' },
};

const emptyContext = {
  currentUser: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GitHub Resolvers', () => {
  describe('Query.githubAppUrl', () => {
    it('should return app URL for authenticated user', async () => {
      vi.mocked(githubService.getAppUrl).mockResolvedValue({
        url: 'https://github.com/apps/test-app/installations/new?state=abc123',
        state: 'abc123',
      });

      const result = await githubResolvers.Query.githubAppUrl({}, {}, mockContext);

      expect(result).toEqual({
        url: expect.stringContaining('github.com/apps/'),
        state: expect.any(String),
      });
      expect(githubService.getAppUrl).toHaveBeenCalledWith('user1');
    });

    it('should throw when not authenticated', async () => {
      await expect(
        githubResolvers.Query.githubAppUrl({}, {}, emptyContext),
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('Query.githubAccounts', () => {
    it('should return accounts for authenticated user', async () => {
      const mockAccounts = [
        { id: 'acc1', githubUserId: 12345, githubLogin: 'testuser', installations: [] },
      ];
      vi.mocked(githubService.getAccounts).mockResolvedValue(mockAccounts);

      const result = await githubResolvers.Query.githubAccounts({}, {}, mockContext);

      expect(result).toEqual(mockAccounts);
      expect(githubService.getAccounts).toHaveBeenCalledWith('user1');
    });

    it('should throw when not authenticated', async () => {
      await expect(
        githubResolvers.Query.githubAccounts({}, {}, emptyContext),
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('Mutation.unbindGitHubAccount', () => {
    it('should unbind account for authenticated user', async () => {
      vi.mocked(githubService.unbindAccount).mockResolvedValue(true);

      const result = await githubResolvers.Mutation.unbindGitHubAccount(
        {}, { accountId: 'acc1' }, mockContext,
      );

      expect(result).toBe(true);
      expect(githubService.unbindAccount).toHaveBeenCalledWith('user1', 'acc1');
    });

    it('should throw when not authenticated', async () => {
      await expect(
        githubResolvers.Mutation.unbindGitHubAccount({}, { accountId: 'acc1' }, emptyContext),
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('Mutation.refreshGitHubInstallations', () => {
    it('should refresh installations for authenticated user', async () => {
      const mockAccount = { id: 'acc1', installations: [] };
      vi.mocked(githubService.refreshInstallations).mockResolvedValue(mockAccount);

      const result = await githubResolvers.Mutation.refreshGitHubInstallations(
        {}, { accountId: 'acc1' }, mockContext,
      );

      expect(result).toEqual(mockAccount);
      expect(githubService.refreshInstallations).toHaveBeenCalledWith('user1', 'acc1');
    });

    it('should throw when not authenticated', async () => {
      await expect(
        githubResolvers.Mutation.refreshGitHubInstallations({}, { accountId: 'acc1' }, emptyContext),
      ).rejects.toThrow('Not authenticated');
    });
  });
});
