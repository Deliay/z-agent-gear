import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('jsonwebtoken', () => ({
  default: { sign: vi.fn().mockReturnValue('fake-jwt') },
  sign: vi.fn().mockReturnValue('fake-jwt'),
}));

vi.mock('../models/github-account.js', () => ({
  GitHubAccount: {
    find: vi.fn(),
    findById: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
    deleteOne: vi.fn(),
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
    githubAppPrivateKey: 'fake-private-key',
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
    it('should uninstall app and delete installations when account exists', async () => {
      const mockInstallations = [{ installationId: 42 }, { installationId: 43 }];

      vi.mocked(GitHubAccount.findOne).mockResolvedValue({ _id: 'acc1' } as any);
      vi.mocked(GitHubInstallation.find).mockResolvedValue(mockInstallations as any);
      vi.mocked(GitHubInstallation.deleteMany).mockResolvedValue({ deletedCount: 2 } as any);

      const fetchCalls: any[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((...args: any[]) => {
        fetchCalls.push(args);
        return Promise.resolve({ ok: true } as any);
      }) as any;

      const result = await githubService.unbindAccount('user1', 'acc1');

      globalThis.fetch = originalFetch;

      expect(result).toBe(true);
      expect(GitHubAccount.findOne).toHaveBeenCalledWith({ _id: 'acc1', userId: 'user1' });
      expect(GitHubInstallation.find).toHaveBeenCalledWith({ accountId: 'acc1' });
      expect(fetchCalls.length).toBe(2);
      expect(fetchCalls[0][0]).toBe('https://api.github.com/app/installations/42');
      expect(fetchCalls[1][0]).toBe('https://api.github.com/app/installations/43');
      expect(GitHubInstallation.deleteMany).toHaveBeenCalledWith({ accountId: 'acc1' });
      expect(GitHubAccount.deleteOne).toHaveBeenCalledWith({ _id: 'acc1', userId: 'user1' });
    });

    it('should clean up local data even if uninstall fails', async () => {
      vi.mocked(GitHubAccount.findOne).mockResolvedValue({ _id: 'acc1' } as any);
      vi.mocked(GitHubInstallation.find).mockResolvedValue([{ installationId: 42 }] as any);
      vi.mocked(GitHubInstallation.deleteMany).mockResolvedValue({ deletedCount: 1 } as any);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() => Promise.reject(new Error('Network error'))) as any;

      const result = await githubService.unbindAccount('user1', 'acc1');

      globalThis.fetch = originalFetch;

      expect(result).toBe(true);
      expect(GitHubInstallation.deleteMany).toHaveBeenCalled();
    });

    it('should return false when account not found', async () => {
      vi.mocked(GitHubAccount.findOne).mockResolvedValue(null);

      const result = await githubService.unbindAccount('user1', 'nonexistent');

      expect(result).toBe(false);
      expect(GitHubInstallation.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('createRepoScopedToken', () => {
    const account = { _id: 'acc1' };
    const installations = [
      {
        installationId: 42,
        repos: [{ fullName: 'Owner/Repo' }],
      },
    ];

    beforeEach(() => {
      vi.mocked(GitHubAccount.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue(account),
      } as never);
      vi.mocked(GitHubInstallation.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue(installations),
      } as never);
    });

    it('T-GH1/T-GH4: 命中安装与仓库（大小写不敏感），body 限定 repositories 与 App 已授权权限', async () => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              token: 'ghs_scoped',
              expires_at: '2026-10-22T01:00:00.000Z',
            }),
        } as Response);
      }) as any;

      const result = await githubService.createRepoScopedToken('acc1', 'owner/repo');
      globalThis.fetch = originalFetch;

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.github.com/app/installations/42/access_tokens');
      expect(JSON.parse(String(calls[0].init.body))).toEqual({
        repositories: ['repo'],
        permissions: {
          actions: 'write',
          contents: 'write',
          deployments: 'write',
          environments: 'write',
          issues: 'write',
          pull_requests: 'write',
          workflows: 'write',
        },
      });
      expect(result).toEqual({
        token: 'ghs_scoped',
        expiresAt: new Date('2026-10-22T01:00:00.000Z'),
      });
    });

    it('T-GH2: 仓库不在授权列表时抛错且不发起 fetch', async () => {
      const fetchSpy = vi.fn();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchSpy as any;

      await expect(
        githubService.createRepoScopedToken('acc1', 'other/repo'),
      ).rejects.toThrow('repository is not authorized');
      expect(fetchSpy).not.toHaveBeenCalled();
      globalThis.fetch = originalFetch;
    });

    it('T-GH3: GitHub 非 2xx 抛固定错误且不含响应体', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() =>
        Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ message: 'bad token detail' }),
        } as Response)) as any;

      await expect(
        githubService.createRepoScopedToken('acc1', 'Owner/Repo'),
      ).rejects.toThrow('failed to issue github token');
      globalThis.fetch = originalFetch;
    });

    it('T-GH5: account 不存在', async () => {
      vi.mocked(GitHubAccount.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(
        githubService.createRepoScopedToken('missing', 'Owner/Repo'),
      ).rejects.toThrow('account not found');
    });
  });
});
