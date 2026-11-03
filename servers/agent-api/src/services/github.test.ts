import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('jsonwebtoken', () => ({
  default: { sign: vi.fn().mockReturnValue('fake-jwt') },
  sign: vi.fn().mockReturnValue('fake-jwt'),
}));

const { redisMock } = vi.hoisted(() => ({
  redisMock: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: () => redisMock,
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

vi.mock('../models/workspace.js', () => ({
  Workspace: { findById: vi.fn(), findOne: vi.fn() },
}));
vi.mock('../models/tenant-member.js', () => ({
  TenantMember: { findOne: vi.fn() },
}));
vi.mock('../models/workspace-member.js', () => ({
  WorkspaceMember: { findOne: vi.fn() },
}));
vi.mock('../models/github-installation.js', () => ({
  GitHubInstallation: {
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateMany: vi.fn(),
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

import { logger as rootLogger } from '../observability/logger.js';
import { createTestLogger } from '../observability/testing.js';

/**
 * 注入 createTestLogger：在被测模块加载前拦截 `rootLogger.child(...)`，把
 * github 告警写入内存 sink，断言 `records` 的结构化字段。
 */
const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const { githubService, resetRepoTokenCache, resetAppBotIdentityCache } = await import('./github.js');
childSpy.mockRestore();

import { GitHubAccount } from '../models/github-account.js';
import { GitHubInstallation } from '../models/github-installation.js';
import { Workspace } from '../models/workspace.js';
import { TenantMember } from '../models/tenant-member.js';
import { WorkspaceMember } from '../models/workspace-member.js';
import { runWithWorkspace } from './workspace-context.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(GitHubAccount.find).mockReturnValue({
    select: () => ({ lean: async () => [] }),
  } as never);
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

      vi.mocked(GitHubAccount.findOne).mockResolvedValue({ _id: 'acc1', githubUserId: 42 } as any);
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
      expect(GitHubInstallation.find).toHaveBeenCalledWith(
        expect.objectContaining({
          $or: expect.arrayContaining([expect.objectContaining({ githubUserId: 42 })]),
        }),
      );
      expect(fetchCalls.length).toBe(2);
      expect(fetchCalls[0][0]).toBe('https://api.github.com/app/installations/42');
      expect(fetchCalls[1][0]).toBe('https://api.github.com/app/installations/43');
      expect(GitHubInstallation.deleteMany).toHaveBeenCalledWith({ githubUserId: 42 });
      expect(GitHubAccount.deleteOne).toHaveBeenCalledWith({ _id: 'acc1', userId: 'user1' });
    });

    it('should clean up local data even if uninstall fails', async () => {
      vi.mocked(GitHubAccount.findOne).mockResolvedValue({ _id: 'acc1', githubUserId: 42 } as any);
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

    it('T-GH9 (REPRO): 容器 50 分钟后续期不得命中仅剩 10 分钟有效期的缓存 token', async () => {
      const t0 = Date.parse('2026-10-22T10:00:00.000Z');
      let now = t0;
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const originalFetch = globalThis.fetch;
      let minted = 0;
      const fetchSpy = vi.fn(() => {
        minted += 1;
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              token: `ghs_${minted}`,
              expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
            }),
        } as Response);
      });
      globalThis.fetch = fetchSpy as never;

      // 容器侧契约：每 50 分钟续期一次，且要求交出的凭据留足 50 分钟可用期。
      const CONTAINER_MIN_REMAINING_MS = 55 * 60 * 1000;
      const mint = (githubService.createRepoScopedToken as unknown as (
        accountId: string,
        repoFullName: string,
        options?: { minRemainingMs?: number },
      ) => Promise<{ token: string; expiresAt: Date }>).bind(githubService);

      const first = await mint('acc1', 'Owner/Repo', {
        minRemainingMs: CONTAINER_MIN_REMAINING_MS,
      });
      now = t0 + 50 * 60 * 1000;
      const second = await mint('acc1', 'Owner/Repo', {
        minRemainingMs: CONTAINER_MIN_REMAINING_MS,
      });

      globalThis.fetch = originalFetch;
      nowSpy.mockRestore();

      // 实际：第二次命中缓存，返回 10 分钟后到期的同一枚 token（容器随后 40 分钟无可用凭据）。
      expect(second.expiresAt.getTime() - now).toBeGreaterThanOrEqual(CONTAINER_MIN_REMAINING_MS);
      expect(second.token).not.toBe(first.token);
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

  describe('resolveAppBotIdentity (Commit 提交身份)', () => {
    const appPayload = { slug: 'zag-bot' };
    const botPayload = { id: 123456 };

    beforeEach(() => {
      resetAppBotIdentityCache();
      redisMock.get.mockReset().mockResolvedValue(null);
      redisMock.set.mockReset().mockResolvedValue('OK');
    });

    it('T-GB1: 解析成功并写入 24h 缓存；二次调用不再打 GitHub（内存命中）', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => appPayload })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => botPayload });
      vi.stubGlobal('fetch', fetchMock);

      const first = await githubService.resolveAppBotIdentity();
      expect(first).toEqual({
        slug: 'zag-bot',
        botUserId: 123456,
        name: 'zag-bot[bot]',
        email: '123456+zag-bot[bot]@users.noreply.github.com',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.github.com/app');
      expect(String(fetchMock.mock.calls[1]![0])).toBe(
        'https://api.github.com/users/zag-bot%5Bbot%5D',
      );
      expect(redisMock.set).toHaveBeenCalledWith(
        'github:app-bot-identity',
        JSON.stringify(first),
        'EX',
        24 * 60 * 60,
      );

      const second = await githubService.resolveAppBotIdentity();
      expect(second).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      vi.unstubAllGlobals();
    });

    it('T-GB1: Redis 命中成功缓存时不发起外部请求', async () => {
      const cached = {
        slug: 'zag-bot',
        botUserId: 123456,
        name: 'zag-bot[bot]',
        email: '123456+zag-bot[bot]@users.noreply.github.com',
      };
      redisMock.get.mockResolvedValue(JSON.stringify(cached));
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(githubService.resolveAppBotIdentity()).resolves.toEqual(cached);
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('T-GB2: 失败写 60s sentinel，窗口内不重试外部调用', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      vi.stubGlobal('fetch', fetchMock);

      await expect(githubService.resolveAppBotIdentity()).resolves.toBeNull();
      expect(redisMock.set).toHaveBeenCalledWith(
        'github:app-bot-identity',
        '__fail__',
        'EX',
        60,
      );

      await expect(githubService.resolveAppBotIdentity()).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    });

    it('T-GB3: 失败告警不含 JWT', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      vi.stubGlobal('fetch', fetchMock);
      testLog.reset();

      await githubService.resolveAppBotIdentity();

      const logged = testLog.records.map((r) => JSON.stringify(r)).join(' ');
      expect(logged).not.toContain('fake-jwt');
      expect(logged).toContain('GET /app failed: 500');
      vi.unstubAllGlobals();
    });
  });

  describe('getRepoDefaultBranch', () => {
    beforeEach(() => {
      vi.spyOn(githubService, 'resolveRepoAccount').mockResolvedValue('acc-1');
      vi.spyOn(githubService, 'createRepoScopedToken').mockResolvedValue({
        token: 'token-scoped',
        expiresAt: new Date(),
      });
    });

    it('T-GH10a: 2xx 返回 default_branch，请求带 repo-scoped token', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ default_branch: 'trunk' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        githubService.getRepoDefaultBranch('user-1', 'owner/repo'),
      ).resolves.toBe('trunk');

      expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.github.com/repos/owner/repo');
      expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
        Authorization: 'Bearer token-scoped',
      });
      vi.unstubAllGlobals();
    });

    it('T-GH10b: 非 2xx 返回 null 且不抛出', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }),
      );

      await expect(
        githubService.getRepoDefaultBranch('user-1', 'owner/repo'),
      ).resolves.toBeNull();
      vi.unstubAllGlobals();
    });

    it('T-GH10c: repoToken 失败返回 null 且不发起 fetch', async () => {
      vi.mocked(githubService.resolveRepoAccount).mockRejectedValueOnce(
        new Error('repo not authorized: owner/repo'),
      );
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        githubService.getRepoDefaultBranch('user-1', 'owner/repo'),
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('T-GH10d: 响应缺 default_branch 返回 null', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }),
      );

      await expect(
        githubService.getRepoDefaultBranch('user-1', 'owner/repo'),
      ).resolves.toBeNull();
      vi.unstubAllGlobals();
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

describe('GitHub 绑定工作区归属（阻断-A/C）', () => {
  function lean<T>(value: T) {
    return { lean: async () => value, select: () => lean(value) } as never;
  }
  const WS_NORMAL = '507f1f77bcf86cd799439071';
  const WS_GLOBAL = '507f1f77bcf86cd799439072';

  it('resolveSetupWorkspace：normal 工作区需成员资格，否则 workspace not found', async () => {
    vi.mocked(Workspace.findById).mockReturnValue(
      lean({ _id: WS_NORMAL, tenantId: 'tenant-team', type: 'normal' }) as never,
    );
    vi.mocked(TenantMember.findOne).mockReturnValue(lean({ role: 'developer' }) as never);
    vi.mocked(WorkspaceMember.findOne).mockReturnValue(lean(null) as never);

    await expect(
      (githubService as unknown as { resolveSetupWorkspace: (u: string, w: string) => Promise<unknown> })
        .resolveSetupWorkspace('user1', WS_NORMAL),
    ).rejects.toThrow('workspace not found');

    vi.mocked(WorkspaceMember.findOne).mockReturnValue(lean({ _id: 'm1' }) as never);
    await expect(
      (githubService as unknown as { resolveSetupWorkspace: (u: string, w: string) => Promise<unknown> })
        .resolveSetupWorkspace('user1', WS_NORMAL),
    ).resolves.toEqual({ workspaceId: WS_NORMAL, tenantId: 'tenant-team' });
  });

  it('resolveSetupWorkspace：全局工作区 + developer 拒绝（只读红线）', async () => {
    vi.mocked(Workspace.findById).mockReturnValue(
      lean({ _id: WS_GLOBAL, tenantId: 'tenant-team', type: 'global' }) as never,
    );
    vi.mocked(TenantMember.findOne).mockReturnValue(lean({ role: 'developer' }) as never);

    await expect(
      (githubService as unknown as { resolveSetupWorkspace: (u: string, w: string) => Promise<unknown> })
        .resolveSetupWorkspace('user1', WS_GLOBAL),
    ).rejects.toThrow('global workspace is read-only');
  });

  it('unbindAccount：共享行越界删除抛 workspace not found 且不删安装数据', async () => {
    vi.mocked(GitHubAccount.findOne).mockResolvedValue({
      _id: 'acc-global',
      workspaceId: WS_GLOBAL,
    } as never);

    await runWithWorkspace(
      {
        id: WS_NORMAL,
        tenantId: 'tenant-team',
        type: 'normal',
        role: 'developer',
        readOnly: false,
        globalWorkspaceId: WS_GLOBAL,
      },
      async () => {
        await expect(githubService.unbindAccount('user1', 'acc-global')).rejects.toThrow(
          'workspace not found',
        );
      },
    );
    expect(GitHubInstallation.deleteMany).not.toHaveBeenCalled();
    expect(GitHubAccount.deleteOne).not.toHaveBeenCalled();
  });

  it('unbindAccount：全局工作区 developer 只读拒绝', async () => {
    vi.mocked(GitHubAccount.findOne).mockResolvedValue({
      _id: 'acc-global',
      workspaceId: WS_GLOBAL,
    } as never);
    await runWithWorkspace(
      {
        id: WS_GLOBAL,
        tenantId: 'tenant-team',
        type: 'global',
        role: 'developer',
        readOnly: true,
        globalWorkspaceId: WS_GLOBAL,
      },
      async () => {
        await expect(githubService.unbindAccount('user1', 'acc-global')).rejects.toThrow(
          'global workspace is read-only',
        );
      },
    );
    expect(GitHubInstallation.deleteMany).not.toHaveBeenCalled();
  });
});

describe('handleSetup 落账（阻断-E/F）', () => {
  function lean<T>(value: T) {
    return { lean: async () => value, select: () => lean(value) } as never;
  }
  const WS = '507f1f77bcf86cd799439081';
  const TENANT = '507f1f77bcf86cd799439082';

  beforeEach(() => {
    vi.mocked(Workspace.findById).mockReturnValue(
      lean({ _id: WS, tenantId: TENANT, type: 'normal' }) as never,
    );
    vi.mocked(TenantMember.findOne).mockReturnValue(lean({ role: 'admin' }) as never);
    vi.spyOn(
      githubService as unknown as { getInstallationToken: (id: number) => Promise<unknown> },
      'getInstallationToken',
    ).mockResolvedValue({ token: 'inst-token', expiresAt: new Date(Date.now() + 3600_000) });
    vi.spyOn(
      githubService as unknown as { getInstallationAccount: (id: number) => Promise<unknown> },
      'getInstallationAccount',
    ).mockResolvedValue({ id: 42, login: 'octo', avatar_url: 'a', type: 'User' });
    vi.spyOn(
      githubService as unknown as { getRepositories: (t: string) => Promise<unknown> },
      'getRepositories',
    ).mockResolvedValue([]);
    vi.mocked(GitHubInstallation.findOneAndUpdate).mockReturnValue({
      lean: async () => ({}),
    } as never);
  });

  it('upsert 键对齐唯一索引（不含 userId），userId 仅 $setOnInsert，安装行写 githubUserId', async () => {
    vi.mocked(GitHubAccount.findOneAndUpdate).mockResolvedValue({
      _id: 'acc-a',
      githubUserId: 42,
    } as never);

    await githubService.handleSetup({
      installationId: 7,
      state: 's',
      userId: 'user-a',
      workspaceId: WS,
    });

    expect(GitHubAccount.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: TENANT, workspaceId: WS, githubUserId: 42 },
      expect.objectContaining({
        $setOnInsert: { userId: 'user-a' },
        $set: expect.objectContaining({ tenantId: TENANT, workspaceId: WS }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(GitHubInstallation.findOneAndUpdate).toHaveBeenCalledWith(
      { installationId: 7 },
      expect.objectContaining({ githubUserId: 42, accountId: 'acc-a' }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('同工作区第二人绑定同账号：顺序 upsert 不因 userId 撞唯一索引', async () => {
    vi.mocked(GitHubAccount.findOneAndUpdate)
      .mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }))
      .mockResolvedValueOnce({ _id: 'acc-existing', githubUserId: 42 } as never);

    await githubService.handleSetup({
      installationId: 7,
      state: 's',
      userId: 'user-b',
      workspaceId: WS,
    });

    const [firstFilter, , firstOptions] = vi.mocked(GitHubAccount.findOneAndUpdate).mock.calls[0];
    expect(firstFilter).toEqual({ tenantId: TENANT, workspaceId: WS, githubUserId: 42 });
    expect((firstFilter as unknown as Record<string, unknown>).userId).toBeUndefined();
    expect(firstOptions).toMatchObject({ upsert: true });
    expect(GitHubAccount.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('同一 GitHub 账号跨工作区两条绑定共享同一安装数据（不改嫁）', async () => {
    vi.mocked(GitHubAccount.find).mockReturnValue({
      lean: async () => [
      { _id: 'acc-personal', githubUserId: 42, workspaceId: 'ws-personal' },
      { _id: 'acc-team', githubUserId: 42, workspaceId: WS },
      ],
    } as never);
    vi.mocked(GitHubInstallation.find).mockResolvedValue([
      {
        _id: 'inst-1',
        accountId: 'acc-personal',
        githubUserId: 42,
        installationId: 7,
        accountLogin: 'octo',
        accountType: 'User',
        repos: [{ repoId: 1, repoName: 'r', fullName: 'o/r', private: false, permissions: { read: true, write: true } }],
        createdAt: new Date(),
      },
    ] as never);

    const accounts = await githubService.getAccounts('user-a');
    expect(accounts).toHaveLength(2);
    expect(accounts[0].installations).toHaveLength(1);
    expect(accounts[1].installations).toHaveLength(1);
    expect(accounts[1].installations[0].repos[0].fullName).toBe('o/r');
  });
});
