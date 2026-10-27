import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/user-commit-setting.js', () => ({
  COMMITTER_MODES: ['agent_only', 'co_author', 'human_only', 'unset'],
  COMMITTER_TYPES: ['github_account', 'custom', 'unset'],
  UserCommitSetting: { findOne: vi.fn(), findOneAndUpdate: vi.fn() },
}));
vi.mock('../models/github-account.js', () => ({
  GitHubAccount: { findOne: vi.fn() },
}));
vi.mock('../models/cloud-host.js', () => ({
  CloudHost: { findOne: vi.fn() },
}));
vi.mock('../models/cloud-host-github-binding.js', () => ({
  CloudHostGithubBinding: { findOne: vi.fn() },
}));
vi.mock('../models/cloud-container.js', () => ({
  CloudContainer: { findOne: vi.fn() },
}));
vi.mock('./github.js', () => ({
  githubService: { resolveAppBotIdentity: vi.fn() },
}));

import { UserCommitSetting } from '../models/user-commit-setting.js';
import { GitHubAccount } from '../models/github-account.js';
import { CloudHost } from '../models/cloud-host.js';
import { CloudHostGithubBinding } from '../models/cloud-host-github-binding.js';
import { CloudContainer } from '../models/cloud-container.js';
import { githubService } from './github.js';
import {
  CommitSettingsService,
  COMMIT_SETTINGS_ERRORS,
  isValidCustomCommitter,
} from './commit-settings-service.js';

const USER_ID = '507f1f77bcf86cd799439011';
const ACCOUNT_ID = '507f1f77bcf86cd799439012';
const OTHER_ACCOUNT_ID = '507f1f77bcf86cd799439013';
const CONTROLLER_ID = '507f1f77bcf86cd799439014';
const HOST_ID = '507f1f77bcf86cd799439015';

function lean<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

function hostDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: HOST_ID,
    controllerId: CONTROLLER_ID,
    userId: USER_ID,
    deletedAt: null,
    ...overrides,
  };
}

const BOT = {
  slug: 'zag-bot',
  botUserId: 123456,
  name: 'zag-bot[bot]',
  email: '123456+zag-bot[bot]@users.noreply.github.com',
};

function mockHost(host: Record<string, unknown> | null = hostDoc()) {
  vi.mocked(CloudHost.findOne).mockReturnValue(lean(host) as never);
}

function mockSetting(setting: Record<string, unknown> | null) {
  vi.mocked(UserCommitSetting.findOne).mockReturnValue(lean(setting) as never);
}

function mockAccount(account: Record<string, unknown> | null) {
  vi.mocked(GitHubAccount.findOne).mockReturnValue(lean(account) as never);
}

function mockSaved(setting: Record<string, unknown>) {
  vi.mocked(UserCommitSetting.findOneAndUpdate).mockReturnValue(lean(setting) as never);
}

function mockBinding(binding: Record<string, unknown> | null) {
  vi.mocked(CloudHostGithubBinding.findOne).mockReturnValue(lean(binding) as never);
}

function mockContainer(installedWorkloads: Array<Record<string, unknown>>) {
  vi.mocked(CloudContainer.findOne).mockReturnValue({
    sort: vi.fn().mockReturnValue(lean({ installedWorkloads })),
  } as never);
}

const service = new CommitSettingsService();

beforeEach(() => {
  vi.clearAllMocks();
  mockContainer([]);
  mockBinding(null);
  vi.mocked(githubService.resolveAppBotIdentity).mockResolvedValue(BOT);
});

describe('CommitSettingsService CRUD', () => {
  it('T-CS1: 从未保存返回双 UNSET 默认值', async () => {
    mockSetting(null);
    const result = await service.getCommitSettings(USER_ID);
    expect(result).toEqual({
      committerMode: 'UNSET',
      committerType: 'UNSET',
      githubAccountId: null,
      customName: null,
      customEmail: null,
    });
  });

  it('T-CS2: CO_AUTHOR/HUMAN_ONLY + UNSET 提交人 → committer is required', async () => {
    for (const mode of ['CO_AUTHOR', 'HUMAN_ONLY']) {
      await expect(
        service.updateCommitSettings(USER_ID, { committerMode: mode, committerType: 'UNSET' }),
      ).rejects.toThrow(COMMIT_SETTINGS_ERRORS.committerRequired);
    }
    expect(UserCommitSetting.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('T-CS2: GITHUB_ACCOUNT 缺失 / 越权帐号 → invalid github account', async () => {
    await expect(
      service.updateCommitSettings(USER_ID, {
        committerMode: 'HUMAN_ONLY',
        committerType: 'GITHUB_ACCOUNT',
      }),
    ).rejects.toThrow(COMMIT_SETTINGS_ERRORS.invalidGithubAccount);

    mockAccount(null);
    await expect(
      service.updateCommitSettings(USER_ID, {
        committerMode: 'HUMAN_ONLY',
        committerType: 'GITHUB_ACCOUNT',
        githubAccountId: OTHER_ACCOUNT_ID,
      }),
    ).rejects.toThrow(COMMIT_SETTINGS_ERRORS.invalidGithubAccount);
    expect(GitHubAccount.findOne).toHaveBeenCalledWith({
      _id: OTHER_ACCOUNT_ID,
      userId: USER_ID,
    });
  });

  it('T-CS2: CUSTOM 空 / 超长 / 换行 / 非法邮箱 → invalid custom committer', async () => {
    const cases = [
      { customName: '  ', customEmail: 'a@b.com' },
      { customName: 'a'.repeat(101), customEmail: 'a@b.com' },
      { customName: 'a\nb', customEmail: 'a@b.com' },
      { customName: 'name', customEmail: '' },
      { customName: 'name', customEmail: 'not-an-email' },
      { customName: 'name', customEmail: `${'a'.repeat(250)}@b.com` },
    ];
    for (const input of cases) {
      await expect(
        service.updateCommitSettings(USER_ID, {
          committerMode: 'HUMAN_ONLY',
          committerType: 'CUSTOM',
          ...input,
        }),
      ).rejects.toThrow(COMMIT_SETTINGS_ERRORS.invalidCustomCommitter);
    }
  });

  it('T-CS2: 校验规则与服务端同源（trim / 长度 / 邮箱正则）', () => {
    expect(isValidCustomCommitter(' name ', ' a@b.com ')).toEqual({
      ok: true,
      name: 'name',
      email: 'a@b.com',
    });
    expect(isValidCustomCommitter('a'.repeat(100), 'a@b.com').ok).toBe(true);
    expect(isValidCustomCommitter('a'.repeat(101), 'a@b.com').ok).toBe(false);
    expect(isValidCustomCommitter('name', 'a@b').ok).toBe(false);
    expect(isValidCustomCommitter('name\r', 'a@b.com').ok).toBe(false);
    expect(isValidCustomCommitter('name\0', 'a@b.com').ok).toBe(false);
  });

  it('T-CS3: type=unset 清空全部冗余字段（mode=UNSET 不清空提交人）', async () => {
    mockSaved({
      committerMode: 'unset',
      committerType: 'unset',
      githubAccountId: null,
      customName: null,
      customEmail: null,
    });

    await service.updateCommitSettings(USER_ID, {
      committerMode: 'UNSET',
      committerType: 'UNSET',
      githubAccountId: ACCOUNT_ID,
      customName: 'name',
      customEmail: 'a@b.com',
    });

    expect(UserCommitSetting.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: USER_ID },
      {
        $set: {
          committerMode: 'unset',
          committerType: 'unset',
          githubAccountId: null,
          customName: null,
          customEmail: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  });

  it('T-CS3: GITHUB_ACCOUNT 清空自定义字段；CUSTOM 清空帐号', async () => {
    mockAccount({ _id: ACCOUNT_ID, userId: USER_ID, githubUserId: 1, githubLogin: 'user' });
    mockSaved({
      committerMode: 'co_author',
      committerType: 'github_account',
      githubAccountId: ACCOUNT_ID,
      customName: null,
      customEmail: null,
    });
    await service.updateCommitSettings(USER_ID, {
      committerMode: 'CO_AUTHOR',
      committerType: 'GITHUB_ACCOUNT',
      githubAccountId: ACCOUNT_ID,
      customName: 'ignored',
      customEmail: 'ignored@b.com',
    });
    expect(vi.mocked(UserCommitSetting.findOneAndUpdate).mock.calls[0]![1]).toEqual({
      $set: {
        committerMode: 'co_author',
        committerType: 'github_account',
        githubAccountId: expect.anything(),
        customName: null,
        customEmail: null,
      },
    });

    mockSaved({
      committerMode: 'human_only',
      committerType: 'custom',
      githubAccountId: null,
      customName: 'name',
      customEmail: 'a@b.com',
    });
    await service.updateCommitSettings(USER_ID, {
      committerMode: 'HUMAN_ONLY',
      committerType: 'CUSTOM',
      githubAccountId: ACCOUNT_ID,
      customName: ' name ',
      customEmail: ' a@b.com ',
    });
    expect(vi.mocked(UserCommitSetting.findOneAndUpdate).mock.calls[1]![1]).toEqual({
      $set: {
        committerMode: 'human_only',
        committerType: 'custom',
        githubAccountId: null,
        customName: 'name',
        customEmail: 'a@b.com',
      },
    });
  });

  it('T-CS3: mode=UNSET + type=github_account 保留提交人（先填提交人后选模式）', async () => {
    mockAccount({ _id: ACCOUNT_ID, userId: USER_ID, githubUserId: 1, githubLogin: 'user' });
    mockSaved({
      committerMode: 'unset',
      committerType: 'github_account',
      githubAccountId: ACCOUNT_ID,
      customName: null,
      customEmail: null,
    });
    const result = await service.updateCommitSettings(USER_ID, {
      committerMode: 'UNSET',
      committerType: 'GITHUB_ACCOUNT',
      githubAccountId: ACCOUNT_ID,
    });
    expect(result.committerMode).toBe('UNSET');
    expect(result.committerType).toBe('GITHUB_ACCOUNT');
    expect(result.githubAccountId).toBe(ACCOUNT_ID);
    expect(vi.mocked(UserCommitSetting.findOneAndUpdate).mock.calls[0]![1]).toEqual({
      $set: expect.objectContaining({
        committerMode: 'unset',
        committerType: 'github_account',
        githubAccountId: expect.anything(),
      }),
    });
  });

  it('T-CS4: 按 userId upsert 幂等（二次保存仍为同一 filter，不新建行）', async () => {
    mockAccount({ _id: ACCOUNT_ID, userId: USER_ID, githubUserId: 1, githubLogin: 'user' });
    mockSaved({
      committerMode: 'human_only',
      committerType: 'github_account',
      githubAccountId: ACCOUNT_ID,
      customName: null,
      customEmail: null,
    });
    await service.updateCommitSettings(USER_ID, {
      committerMode: 'HUMAN_ONLY',
      committerType: 'GITHUB_ACCOUNT',
      githubAccountId: ACCOUNT_ID,
    });
    await service.updateCommitSettings(USER_ID, {
      committerMode: 'CO_AUTHOR',
      committerType: 'GITHUB_ACCOUNT',
      githubAccountId: ACCOUNT_ID,
    });
    const calls = vi.mocked(UserCommitSetting.findOneAndUpdate).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toEqual({ userId: USER_ID });
    expect(calls[1]![0]).toEqual({ userId: USER_ID });
    expect(calls.every((call) => (call[2] as Record<string, unknown>).upsert === true)).toBe(true);
  });
});

describe('CommitSettingsService.resolveCommitIdentity', () => {
  const githubAccount = {
    _id: ACCOUNT_ID,
    userId: USER_ID,
    githubUserId: 777,
    githubLogin: 'octocat',
  };
  const githubSetting = {
    committerMode: 'human_only',
    committerType: 'github_account',
    githubAccountId: ACCOUNT_ID,
  };
  const customSetting = {
    committerMode: 'human_only',
    committerType: 'custom',
    customName: 'Zhang San',
    customEmail: 'zhangsan@example.com',
  };

  it('T-CS5: 主机不存在 / 非法 controllerId / 未保存 → unset', async () => {
    await expect(service.resolveCommitIdentity('not-an-object-id')).resolves.toEqual({
      mode: 'unset',
    });

    mockHost(null);
    mockSetting(githubSetting);
    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({ mode: 'unset' });

    mockHost();
    mockSetting(null);
    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({ mode: 'unset' });
    expect(CloudHost.findOne).toHaveBeenCalledWith({
      controllerId: CONTROLLER_ID,
      deletedAt: null,
    });
  });

  it('T-CS5: 解绑 / 越权帐号降级 unset', async () => {
    mockHost();
    mockSetting(githubSetting);
    mockAccount(null);
    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({ mode: 'unset' });
    expect(GitHubAccount.findOne).toHaveBeenCalledWith({
      _id: expect.anything(),
      userId: USER_ID,
    });
  });

  it('T-CS5: human_only = 提交人（Github 帐号 noreply 邮箱）', async () => {
    mockHost();
    mockSetting(githubSetting);
    mockAccount(githubAccount);

    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({
      mode: 'human_only',
      name: 'octocat',
      email: '777+octocat@users.noreply.github.com',
    });
    expect(githubService.resolveAppBotIdentity).not.toHaveBeenCalled();
  });

  it('T-CS5: human_only = 自定义提交人', async () => {
    mockHost();
    mockSetting(customSetting);
    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({
      mode: 'human_only',
      name: 'Zhang San',
      email: 'zhangsan@example.com',
    });
  });

  it('T-CS5: 非法自定义提交人降级 unset', async () => {
    mockHost();
    mockSetting({ ...customSetting, customEmail: 'not-an-email' });
    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({ mode: 'unset' });
  });

  it('T-CS5: co_author = 提交人 + bot 身份', async () => {
    mockHost();
    mockSetting({ ...githubSetting, committerMode: 'co_author' });
    mockAccount(githubAccount);

    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({
      mode: 'co_author',
      name: 'octocat',
      email: '777+octocat@users.noreply.github.com',
      coAuthorName: BOT.name,
      coAuthorEmail: BOT.email,
    });
  });

  it('T-CS5: agent_only 门控命中（绑定或 installedWorkloads 含 Github）', async () => {
    mockHost();
    mockSetting({ ...githubSetting, committerMode: 'agent_only' });
    mockAccount(githubAccount);
    mockBinding({ controllerId: CONTROLLER_ID });

    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({
      mode: 'agent_only',
      name: BOT.name,
      email: BOT.email,
    });

    mockBinding(null);
    mockContainer([{ workloadId: 'w1', name: 'Github' }]);
    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({
      mode: 'agent_only',
      name: BOT.name,
      email: BOT.email,
    });
  });

  it('T-CS5: agent_only 不依赖提交人字段（type=unset 仍下发 bot）', async () => {
    mockHost();
    mockSetting({ committerMode: 'agent_only', committerType: 'unset' });
    mockBinding({ controllerId: CONTROLLER_ID });

    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({
      mode: 'agent_only',
      name: BOT.name,
      email: BOT.email,
    });
    expect(GitHubAccount.findOne).not.toHaveBeenCalled();
  });

  it('T-CS5: agent_only 门控未命中（无绑定且未安装 Github 负载）→ unset', async () => {
    mockHost();
    mockSetting({ ...githubSetting, committerMode: 'agent_only' });
    mockAccount(githubAccount);
    mockBinding(null);
    mockContainer([{ workloadId: 'w1', name: 'Docker' }]);

    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({ mode: 'unset' });
    expect(githubService.resolveAppBotIdentity).not.toHaveBeenCalled();
  });

  it('T-CS5: bot 解析失败 → co_author / agent_only 均降级 unset', async () => {
    mockHost();
    mockAccount(githubAccount);
    vi.mocked(githubService.resolveAppBotIdentity).mockResolvedValue(null);

    mockSetting({ ...githubSetting, committerMode: 'co_author' });
    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({ mode: 'unset' });

    mockSetting({ ...githubSetting, committerMode: 'agent_only' });
    mockBinding({ controllerId: CONTROLLER_ID });
    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({ mode: 'unset' });
  });

  it('T-CS5: mode=unset / type=unset → unset', async () => {
    mockHost();
    mockSetting({ ...githubSetting, committerMode: 'unset' });
    mockAccount(githubAccount);
    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({ mode: 'unset' });

    mockSetting({ committerMode: 'co_author', committerType: 'unset' });
    await expect(service.resolveCommitIdentity(CONTROLLER_ID)).resolves.toEqual({ mode: 'unset' });
  });

  it('T-CS6: unset 响应仅含 mode；co_author 才含 coAuthor*', async () => {
    mockHost();
    mockSetting({ ...githubSetting, committerMode: 'unset' });
    mockAccount(githubAccount);
    const unset = await service.resolveCommitIdentity(CONTROLLER_ID);
    expect(Object.keys(unset)).toEqual(['mode']);

    mockSetting({ ...githubSetting, committerMode: 'co_author' });
    const coAuthor = await service.resolveCommitIdentity(CONTROLLER_ID);
    expect(Object.keys(coAuthor).sort()).toEqual([
      'coAuthorEmail',
      'coAuthorName',
      'email',
      'mode',
      'name',
    ]);
  });
});
