import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  settingFindOne: vi.fn(),
  settingFindOneAndUpdate: vi.fn(),
  userFindById: vi.fn(),
  resolveAppBotIdentity: vi.fn(),
  workspaceContext: undefined as unknown,
}));

vi.mock('../models/user-commit-setting.js', () => ({
  COMMITTER_TYPES: ['custom', 'unset'],
  UserCommitSetting: {
    findOne: h.settingFindOne,
    findOneAndUpdate: h.settingFindOneAndUpdate,
  },
}));
vi.mock('../models/user.js', () => ({
  User: { findById: h.userFindById },
}));
vi.mock('./github.js', () => ({
  githubService: { resolveAppBotIdentity: h.resolveAppBotIdentity },
}));
vi.mock('./workspace-context.js', () => ({
  getWorkspaceContext: () => h.workspaceContext,
}));

import {
  CommitSettingsService,
  COMMIT_SETTINGS_ERRORS,
  isValidCustomCommitter,
} from './commit-settings-service.js';

const USER_ID = '507f1f77bcf86cd799439011';
const OTHER_USER_ID = '507f1f77bcf86cd799439021';
const TENANT_ID = '507f1f77bcf86cd799439031';

const BOT = {
  slug: 'zag-bot',
  botUserId: 123456,
  name: 'zag-bot[bot]',
  email: '123456+zag-bot[bot]@users.noreply.github.com',
};

function lean<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

function selectLean<T>(value: T) {
  return { select: vi.fn(() => lean(value)) } as never;
}

function mockSetting(setting: Record<string, unknown> | null) {
  h.settingFindOne.mockReturnValue(lean(setting));
}

function service() {
  return new CommitSettingsService();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.workspaceContext = undefined;
  h.userFindById.mockReturnValue(selectLean({ tenantId: TENANT_ID }));
});

describe('commit settings service', () => {
  it('T-CS-P1: 成员级默认值为 UNSET 且 commitWithBot=false', async () => {
    mockSetting(null);
    const view = await service().getCommitSettings(USER_ID);
    expect(view).toEqual({
      committerType: 'UNSET',
      customName: null,
      customEmail: null,
      commitWithBot: false,
    });
    expect(h.settingFindOne).toHaveBeenCalledWith({ userId: USER_ID });
  });

  it('T-CS-P1b: 已保存 custom 设置按 userId 点查返回', async () => {
    mockSetting({
      userId: USER_ID,
      committerType: 'custom',
      customName: 'Alice',
      customEmail: 'alice@example.com',
    });
    const view = await service().getCommitSettings(USER_ID);
    expect(view).toEqual({
      committerType: 'CUSTOM',
      customName: 'Alice',
      customEmail: 'alice@example.com',
      commitWithBot: false,
    });
  });

  it('T-CB1: 已保存 commitWithBot=true 时回显 true，UNSET 时归一 false', async () => {
    mockSetting({
      userId: USER_ID,
      committerType: 'custom',
      customName: 'Alice',
      customEmail: 'alice@example.com',
      commitWithBot: true,
    });
    await expect(service().getCommitSettings(USER_ID)).resolves.toMatchObject({ commitWithBot: true });

    mockSetting({
      userId: USER_ID,
      committerType: 'unset',
      customName: null,
      customEmail: null,
      commitWithBot: true,
    });
    await expect(service().getCommitSettings(USER_ID)).resolves.toMatchObject({ commitWithBot: false });
  });

  it('T-CB2: 保存 commitWithBot 落库；UNSET 归一 false', async () => {
    h.settingFindOneAndUpdate.mockReturnValue(
      lean({
        userId: USER_ID,
        committerType: 'custom',
        customName: 'Alice',
        customEmail: 'a@b.com',
        commitWithBot: true,
      }),
    );
    const view = await service().updateCommitSettings(USER_ID, {
      committerType: 'CUSTOM',
      customName: 'Alice',
      customEmail: 'a@b.com',
      commitWithBot: true,
    });
    expect(view.commitWithBot).toBe(true);
    expect(h.settingFindOneAndUpdate.mock.calls[0][1].$set).toMatchObject({ commitWithBot: true });

    h.settingFindOneAndUpdate.mockReturnValue(
      lean({ userId: USER_ID, committerType: 'unset', customName: null, customEmail: null }),
    );
    const unsetView = await service().updateCommitSettings(USER_ID, {
      committerType: 'UNSET',
      commitWithBot: true,
    });
    expect(unsetView.commitWithBot).toBe(false);
    expect(h.settingFindOneAndUpdate.mock.calls[1][1].$set).toMatchObject({
      committerType: 'unset',
      commitWithBot: false,
    });
  });

  it('T-CS-P2: 校验白名单仅 invalid custom committer（矩阵）', async () => {
    const svc = service();
    const base = { committerType: 'custom' };

    await expect(svc.updateCommitSettings(USER_ID, { ...base, customName: '', customEmail: 'a@b.com' }))
      .rejects.toThrow(COMMIT_SETTINGS_ERRORS.invalidCustomCommitter);
    await expect(svc.updateCommitSettings(USER_ID, { ...base, customName: 'A', customEmail: 'not-an-email' }))
      .rejects.toThrow(COMMIT_SETTINGS_ERRORS.invalidCustomCommitter);
    await expect(
      svc.updateCommitSettings(USER_ID, { ...base, customName: 'A\nB', customEmail: 'a@b.com' }),
    ).rejects.toThrow(COMMIT_SETTINGS_ERRORS.invalidCustomCommitter);
    await expect(
      svc.updateCommitSettings(USER_ID, { ...base, customName: 'x'.repeat(101), customEmail: 'a@b.com' }),
    ).rejects.toThrow(COMMIT_SETTINGS_ERRORS.invalidCustomCommitter);
    await expect(
      svc.updateCommitSettings(USER_ID, { ...base, customName: 'A', customEmail: `${'x'.repeat(250)}@b.com` }),
    ).rejects.toThrow(COMMIT_SETTINGS_ERRORS.invalidCustomCommitter);
    await expect(
      svc.updateCommitSettings(USER_ID, { committerType: 'github_account' } as never),
    ).rejects.toThrow(COMMIT_SETTINGS_ERRORS.invalidCustomCommitter);
    expect(h.settingFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('T-CS-P2b: custom 保存 trim 后落库，unset 清空 custom 字段', async () => {
    h.settingFindOneAndUpdate.mockReturnValue(
      lean({ userId: USER_ID, committerType: 'custom', customName: 'Alice', customEmail: 'a@b.com' }),
    );
    await service().updateCommitSettings(USER_ID, {
      committerType: 'CUSTOM',
      customName: '  Alice  ',
      customEmail: '  a@b.com  ',
    });
    const [, update] = h.settingFindOneAndUpdate.mock.calls[0];
    expect(update.$set).toMatchObject({
      userId: USER_ID,
      tenantId: TENANT_ID,
      committerType: 'custom',
      customName: 'Alice',
      customEmail: 'a@b.com',
    });
    expect(update.$set).not.toHaveProperty('githubAccountId');
    expect(update.$set).not.toHaveProperty('committerMode');

    h.settingFindOneAndUpdate.mockReturnValue(
      lean({ userId: USER_ID, committerType: 'unset', customName: null, customEmail: null }),
    );
    const unsetView = await service().updateCommitSettings(USER_ID, { committerType: 'UNSET' });
    expect(unsetView).toEqual({
      committerType: 'UNSET',
      customName: null,
      customEmail: null,
      commitWithBot: false,
    });
    const unsetUpdate = h.settingFindOneAndUpdate.mock.calls[1][1];
    expect(unsetUpdate.$set).toMatchObject({
      committerType: 'unset',
      customName: null,
      customEmail: null,
    });
  });

  it('T-CS-P3: upsert 幂等（同 userId 二次保存覆盖、不重复建行）', async () => {
    h.settingFindOneAndUpdate.mockReturnValue(
      lean({ userId: USER_ID, committerType: 'custom', customName: 'A', customEmail: 'a@b.com' }),
    );
    await service().updateCommitSettings(USER_ID, {
      committerType: 'CUSTOM',
      customName: 'A',
      customEmail: 'a@b.com',
    });
    h.settingFindOneAndUpdate.mockReturnValue(
      lean({ userId: USER_ID, committerType: 'custom', customName: 'B', customEmail: 'b@b.com' }),
    );
    await service().updateCommitSettings(USER_ID, {
      committerType: 'CUSTOM',
      customName: 'B',
      customEmail: 'b@b.com',
    });

    expect(h.settingFindOneAndUpdate).toHaveBeenCalledTimes(2);
    for (const [filter] of h.settingFindOneAndUpdate.mock.calls) {
      expect(filter).toEqual({ userId: USER_ID });
    }
  });

  it('T-CS-P4: resolveWorktreeCommitter 三态（custom 合法 / unset / 非法）', async () => {
    const svc = service();

    mockSetting({ userId: USER_ID, committerType: 'custom', customName: 'Alice', customEmail: 'a@b.com' });
    await expect(svc.resolveWorktreeCommitter(USER_ID)).resolves.toEqual({
      name: 'Alice',
      email: 'a@b.com',
    });

    mockSetting({ userId: USER_ID, committerType: 'unset', customName: null, customEmail: null });
    await expect(svc.resolveWorktreeCommitter(USER_ID)).resolves.toBeNull();

    mockSetting({ userId: USER_ID, committerType: 'custom', customName: '', customEmail: 'bad' });
    await expect(svc.resolveWorktreeCommitter(USER_ID)).resolves.toBeNull();

    mockSetting(null);
    await expect(svc.resolveWorktreeCommitter(USER_ID)).resolves.toBeNull();
  });

  it('T-CB4: commitWithBot=true 时解析 bot 并追加共同作者', async () => {
    const svc = service();
    h.resolveAppBotIdentity.mockResolvedValue(BOT);
    mockSetting({
      userId: USER_ID,
      committerType: 'custom',
      customName: 'Alice',
      customEmail: 'a@b.com',
      commitWithBot: true,
    });

    await expect(svc.resolveWorktreeCommitter(USER_ID)).resolves.toEqual({
      name: 'Alice',
      email: 'a@b.com',
      coAuthorName: BOT.name,
      coAuthorEmail: BOT.email,
    });
    expect(h.resolveAppBotIdentity).toHaveBeenCalledTimes(1);
  });

  it('T-CB5: commitWithBot=true 但 bot 不可用时降级为仅成员署名', async () => {
    const svc = service();
    h.resolveAppBotIdentity.mockResolvedValue(null);
    mockSetting({
      userId: USER_ID,
      committerType: 'custom',
      customName: 'Alice',
      customEmail: 'a@b.com',
      commitWithBot: true,
    });

    await expect(svc.resolveWorktreeCommitter(USER_ID)).resolves.toEqual({
      name: 'Alice',
      email: 'a@b.com',
    });
  });

  it('T-CB6: commitWithBot=false 不解析 bot', async () => {
    const svc = service();
    mockSetting({
      userId: USER_ID,
      committerType: 'custom',
      customName: 'Alice',
      customEmail: 'a@b.com',
      commitWithBot: false,
    });

    await expect(svc.resolveWorktreeCommitter(USER_ID)).resolves.toEqual({
      name: 'Alice',
      email: 'a@b.com',
    });
    expect(h.resolveAppBotIdentity).not.toHaveBeenCalled();
  });

  it('T-CS-P5: 成员独立隔离（A/B 各自点查互不影响）', async () => {
    const svc = service();
    h.settingFindOne.mockImplementation((filter: { userId: string }) =>
      lean(
        filter.userId === USER_ID
          ? { userId: USER_ID, committerType: 'custom', customName: 'Alice', customEmail: 'a@b.com' }
          : { userId: OTHER_USER_ID, committerType: 'unset', customName: null, customEmail: null },
      ),
    );

    const a = await svc.getCommitSettings(USER_ID);
    const b = await svc.getCommitSettings(OTHER_USER_ID);
    expect(a.committerType).toBe('CUSTOM');
    expect(b).toEqual({
      committerType: 'UNSET',
      customName: null,
      customEmail: null,
      commitWithBot: false,
    });
    expect(h.settingFindOne).toHaveBeenNthCalledWith(1, { userId: USER_ID });
    expect(h.settingFindOne).toHaveBeenNthCalledWith(2, { userId: OTHER_USER_ID });
  });

  it('T-CS-P6: resolveCloudHostIdentity 恒 bot，bot 失败兜底 unset', async () => {
    const svc = service();
    h.resolveAppBotIdentity.mockResolvedValue(BOT);
    await expect(svc.resolveCloudHostIdentity()).resolves.toEqual({
      mode: 'agent_only',
      name: BOT.name,
      email: BOT.email,
    });

    h.resolveAppBotIdentity.mockResolvedValue(null);
    await expect(svc.resolveCloudHostIdentity()).resolves.toEqual({ mode: 'unset' });
  });

  it('isValidCustomCommitter: 邮箱/长度/换行边界', () => {
    expect(isValidCustomCommitter('Alice', 'a@b.com')).toEqual({
      ok: true,
      name: 'Alice',
      email: 'a@b.com',
    });
    expect(isValidCustomCommitter('A', 'a\r@b.com').ok).toBe(false);
    expect(isValidCustomCommitter('A', 'a\0@b.com').ok).toBe(false);
    expect(isValidCustomCommitter('  ', 'a@b.com').ok).toBe(false);
  });
});
