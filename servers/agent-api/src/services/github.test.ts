import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/github-account.js', () => ({
  GitHubAccount: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
  },
}));

vi.mock('../models/github-installation.js', () => ({
  GitHubInstallation: {
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('../config/index.js', () => ({
  config: {
    githubAppId: 'test-app',
    githubAppUrl: 'https://github.com/apps/test-app',
    githubTokenEncryptionKey: '0000000000000000000000000000000000000000000000000000000000000000',
    frontendUrl: 'http://localhost:5173',
  },
}));

import { githubService } from './github.js';
import { GitHubAccount } from '../models/github-account.js';
import { GitHubInstallation } from '../models/github-installation.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GitHubService', () => {
  describe('getAppUrl', () => {
    it('should return URL with state for a user', async () => {
      const result = await githubService.getAppUrl('user1');

      expect(result.url).toContain('github.com/apps/test-app/installations/new');
      expect(result.url).toContain('state=');
      expect(result.state).toBeDefined();
      expect(result.state.length).toBeGreaterThan(0);
    });
  });

  describe('getAccounts', () => {
    it('should return empty array when no accounts', async () => {
      vi.mocked(GitHubAccount.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      } as never);
      vi.mocked(GitHubInstallation.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      } as never);

      const result = await githubService.getAccounts('user1');

      expect(result).toEqual([]);
      expect(GitHubAccount.find).toHaveBeenCalledWith({ userId: 'user1' });
    });

    it('should return accounts with installations', async () => {
      const mockAccounts = [
        {
          _id: { toString: () => 'acc1' },
          githubUserId: 12345,
          githubLogin: 'testuser',
          githubAvatarUrl: 'https://avatars.githubusercontent.com/u/12345',
          createdAt: new Date('2026-01-01'),
        },
      ];

      const mockInstallations = [
        {
          _id: { toString: () => 'inst1' },
          accountId: { toString: () => 'acc1' },
          installationId: 42,
          repos: [
            {
              repoId: 1,
              repoName: 'my-repo',
              fullName: 'testuser/my-repo',
              private: false,
              permissions: { read: true, write: true },
            },
          ],
          createdAt: new Date('2026-01-01'),
        },
      ];

      vi.mocked(GitHubAccount.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockAccounts),
      } as never);

      vi.mocked(GitHubInstallation.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockInstallations),
      } as never);

      const result = await githubService.getAccounts('user1');

      expect(result).toHaveLength(1);
      expect(result[0].githubLogin).toBe('testuser');
      expect(result[0].installations).toHaveLength(1);
      expect(result[0].installations[0].installationId).toBe(42);
      expect(result[0].installations[0].repos[0].fullName).toBe('testuser/my-repo');
    });
  });

  describe('unbindAccount', () => {
    it('should return true when account exists and delete installations', async () => {
      vi.mocked(GitHubAccount.findOneAndDelete).mockResolvedValue({
        _id: 'acc1',
      } as never);
      vi.mocked(GitHubInstallation.deleteMany).mockResolvedValue({ deletedCount: 1 } as never);

      const result = await githubService.unbindAccount('user1', 'acc1');

      expect(result).toBe(true);
      expect(GitHubAccount.findOneAndDelete).toHaveBeenCalledWith({ _id: 'acc1', userId: 'user1' });
      expect(GitHubInstallation.deleteMany).toHaveBeenCalledWith({ accountId: 'acc1' });
    });

    it('should return false when account not found', async () => {
      vi.mocked(GitHubAccount.findOneAndDelete).mockResolvedValue(null);

      const result = await githubService.unbindAccount('user1', 'nonexistent');

      expect(result).toBe(false);
      expect(GitHubInstallation.deleteMany).not.toHaveBeenCalled();
    });
  });
});
