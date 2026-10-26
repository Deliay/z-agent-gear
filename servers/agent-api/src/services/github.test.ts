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

import { githubService, resetRepoTokenCache } from './github.js';
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
      resetRepoTokenCache();
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
          checks: 'write',
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

    it('T-GH6: token 进程内缓存命中不重复签发', async () => {
      const fetchSpy = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ token: 'ghs_cached', expires_at: '2099-01-01T00:00:00.000Z' }),
        } as Response),
      );
      globalThis.fetch = fetchSpy as never;

      const first = await githubService.createRepoScopedToken('acc1', 'Owner/Repo');
      const second = await githubService.createRepoScopedToken('acc1', 'owner/repo');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('T-GH7: 到期前 5 分钟内作废并重新签发', async () => {
      const fetchSpy = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              token: 'ghs_short',
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            }),
        } as Response),
      );
      globalThis.fetch = fetchSpy as never;

      await githubService.createRepoScopedToken('acc1', 'Owner/Repo');
      await githubService.createRepoScopedToken('acc1', 'Owner/Repo');

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('createRepoScopedTokenForUser', () => {
    beforeEach(() => {
      resetRepoTokenCache();
    });

    it('T-GH8: 逐帐号匹配，首个授权仓库的安装胜出', async () => {
      vi.mocked(GitHubAccount.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ _id: 'acc1' }, { _id: 'acc2' }]),
      } as never);
      vi.mocked(GitHubInstallation.find)
        .mockReturnValueOnce({ lean: vi.fn().mockResolvedValue([]) } as never)
        .mockReturnValueOnce({
          lean: vi.fn().mockResolvedValue([
            { installationId: 77, repos: [{ fullName: 'Owner/Repo' }] },
          ]),
        } as never);

      const calls: Array<{ url: string; init: RequestInit }> = [];
      globalThis.fetch = ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ token: 'ghs_user', expires_at: '2099-01-01T00:00:00.000Z' }),
        } as Response);
      }) as never;

      const result = await githubService.createRepoScopedTokenForUser('user-1', 'owner/repo');

      expect(result.token).toBe('ghs_user');
      expect(calls[0].url).toBe('https://api.github.com/app/installations/77/access_tokens');
    });

    it('T-GH9: 全部帐号均未授权时抛错', async () => {
      vi.mocked(GitHubAccount.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ _id: 'acc1' }]),
      } as never);
      vi.mocked(GitHubInstallation.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ installationId: 42, repos: [{ fullName: 'a/b' }] }]),
      } as never);
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as never;

      await expect(
        githubService.createRepoScopedTokenForUser('user-1', 'owner/repo'),
      ).rejects.toThrow('repository is not authorized');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('resolveRepoAccount', () => {
    it('大小写不敏感命中安装仓库并返回账号 ID', async () => {
      vi.mocked(GitHubAccount.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([{ _id: 'acc-1' }]),
        }),
      } as never);
      vi.mocked(GitHubInstallation.find).mockReturnValue({
        lean: vi
          .fn()
          .mockResolvedValue([{ repos: [{ fullName: 'Deliay/Z-Agent-Gear' }] }]),
      } as never);

      await expect(
        githubService.resolveRepoAccount('user-1', 'deliay/z-agent-gear'),
      ).resolves.toBe('acc-1');
    });

    it('无匹配安装 → repo not authorized', async () => {
      vi.mocked(GitHubAccount.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: 'acc-1' }]) }),
      } as never);
      vi.mocked(GitHubInstallation.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ repos: [{ fullName: 'a/b' }] }]),
      } as never);

      await expect(githubService.resolveRepoAccount('user-1', 'c/d')).rejects.toThrow(
        'repo not authorized: c/d',
      );
    });
  });

  describe('labels / comments', () => {
    beforeEach(() => {
      vi.spyOn(githubService, 'createRepoScopedToken').mockResolvedValue({
        token: 'token-1',
        expiresAt: new Date(),
      });
    });

    it('ensureIssueLabel：已存在不发 POST', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      await githubService.ensureIssueLabel('user-1', 'a/b', 'start-dev');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain('/repos/a/b/labels/start-dev');
      vi.unstubAllGlobals();
    });

    it('ensureIssueLabel：404 后 POST 创建；422 视为成功', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockResolvedValueOnce({ ok: false, status: 422 });
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        githubService.ensureIssueLabel('user-1', 'a/b', 'start dev'),
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
      vi.unstubAllGlobals();
    });

    it('deleteIssueLabel：404 视为成功；其他失败抛错', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 });
      vi.stubGlobal('fetch', fetchMock);
      await expect(githubService.deleteIssueLabel('user-1', 'a/b', 'x')).resolves.toBeUndefined();

      const failing = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 });
      vi.stubGlobal('fetch', failing);
      await expect(githubService.deleteIssueLabel('user-1', 'a/b', 'x')).rejects.toThrow(
        'label delete failed: a/b',
      );
      vi.unstubAllGlobals();
    });

    it('createIssueComment 返回 comment id', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: 99 }) });
      vi.stubGlobal('fetch', fetchMock);

      await expect(githubService.createIssueComment('user-1', 'a/b', 42, 'hi')).resolves.toBe(99);
      expect(String(fetchMock.mock.calls[0][0])).toContain('/repos/a/b/issues/42/comments');
      vi.unstubAllGlobals();
    });
  });
});
