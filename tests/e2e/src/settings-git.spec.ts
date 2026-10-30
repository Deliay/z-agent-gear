import { test, expect, type Page } from '@playwright/test';
import { registerUser, loginViaUI } from './helpers.js';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';

/** 会员级提交人设置（服务端已收敛为 committerType + customName/customEmail）。 */
interface CommitSettingsFixture {
  committerType: 'CUSTOM' | 'UNSET';
  customName: string | null;
  customEmail: string | null;
  commitWithBot: boolean;
}

interface PersonalAccountFixture {
  id: string;
  githubUserId: number;
  githubLogin: string;
  githubAvatarUrl: string | null;
}

const EMPTY_SETTINGS: CommitSettingsFixture = {
  committerType: 'UNSET',
  customName: null,
  customEmail: null,
  commitWithBot: false,
};

/** 内联 1x1 占位图：避免 E2E 出站拉取真实头像（截图/离线环境均可断言）。 */
const AVATAR_DATA_URI =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const FIRST_ACCOUNT: PersonalAccountFixture = {
  id: 'mock-personal-acc-1',
  githubUserId: 12345,
  githubLogin: 'e2e-git-user',
  githubAvatarUrl: AVATAR_DATA_URI,
};

const SECOND_ACCOUNT: PersonalAccountFixture = {
  id: 'mock-personal-acc-2',
  githubUserId: 67890,
  githubLogin: 'e2e-git-second',
  githubAvatarUrl: null,
};

interface MockGitGraphQLResult {
  /** 服务端当前保存值（模拟保存后回读一致）。 */
  current: () => CommitSettingsFixture;
  /** 每次 updateCommitSettings 的 input（用于断言「未发起 mutation」/保存值）。 */
  updates: CommitSettingsFixture[];
}

/**
 * 拦截「Git」区块相关 GraphQL（其余请求透传）：
 * - GetCommitSettings / UpdateCommitSettings / GetPersonalGithubAccounts
 * - 服务端状态保存在闭包内，模拟「保存后回读一致」。
 */
async function mockGitGraphQL(
  page: Page,
  options: {
    accounts?: PersonalAccountFixture[];
    initialSettings?: CommitSettingsFixture;
    serverError?: string;
  } = {},
): Promise<MockGitGraphQLResult> {
  let settings: CommitSettingsFixture = { ...(options.initialSettings ?? EMPTY_SETTINGS) };
  const updates: CommitSettingsFixture[] = [];

  await page.route(API_URL, async (route) => {
    const postData = route.request().postDataJSON() as {
      query?: string;
      variables?: { input?: Partial<CommitSettingsFixture> };
    } | null;
    const query = postData?.query ?? '';

    if (query.includes('GetPersonalGithubAccounts')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: { personalGithubAccounts: options.accounts ?? [FIRST_ACCOUNT] },
        }),
      });
      return;
    }

    if (query.includes('GetCommitSettings')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: { commitSettings: settings } }),
      });
      return;
    }

    if (query.includes('UpdateCommitSettings')) {
      if (options.serverError) {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ errors: [{ message: options.serverError }] }),
        });
        return;
      }
      const input = postData?.variables?.input ?? {};
      const saved: CommitSettingsFixture =
        input.committerType === 'CUSTOM'
          ? {
              committerType: 'CUSTOM',
              customName: (input.customName ?? '').trim(),
              customEmail: (input.customEmail ?? '').trim(),
              commitWithBot: input.commitWithBot === true,
            }
          : { ...EMPTY_SETTINGS };
      updates.push(saved);
      settings = saved;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: { updateCommitSettings: saved } }),
      });
      return;
    }

    await route.continue();
  });

  return { current: () => settings, updates };
}

async function openSettings(page: Page): Promise<void> {
  const { username } = await registerUser(page);
  await loginViaUI(page, username);
  await page.click('a[href="/settings"]');
  await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });
}

function gitSection(page: Page) {
  return page.locator('#git-section');
}

function committerTypeGroup(page: Page) {
  return gitSection(page).getByRole('radiogroup', { name: '提交人' });
}

const SAVE_TOAST = '对成员的会话/工作流 Worktree 生效';
const INVALID_COMMITTER_MESSAGE = '提交人用户名或邮箱格式不正确';

test.describe('Settings Git E2E', () => {
  test('E2E-GIT1: 「Git」区块与云电脑提示可见，提交人自定义/未设置可切换并保存', async ({
    page,
  }) => {
    const mocked = await mockGitGraphQL(page);
    await openSettings(page);

    const git = gitSection(page);
    await expect(git.getByTestId('git-settings-section')).toBeVisible();
    await expect(git.getByRole('heading', { name: 'Git', exact: true })).toBeVisible();
    await expect(git.getByText('仅对云电脑环境生效')).toBeVisible();

    // 旧的「Commit 设置」区块与「提交人模式」单选组已下线
    await expect(page.getByText('Commit 设置')).toHaveCount(0);
    await expect(page.getByRole('radiogroup', { name: '提交人模式' })).toHaveCount(0);
    await expect(page.getByText('提交人模式')).toHaveCount(0);

    const group = committerTypeGroup(page);
    await expect(group.getByRole('radio')).toHaveCount(2);
    await expect(group.getByRole('radio', { name: '自定义' })).not.toBeChecked();
    await expect(group.getByRole('radio', { name: '未设置' })).toBeChecked();
    // 仅自定义时出现用户名 / 邮箱与导入入口
    await expect(git.getByLabel('用户名')).toHaveCount(0);

    // 切到「自定义」→ 填写 → 保存
    await group.getByRole('radio', { name: '自定义' }).check();
    await expect(git.getByLabel('用户名')).toBeVisible();
    await expect(git.getByLabel('邮箱')).toBeVisible();
    await expect(git.getByRole('button', { name: '导入Github帐号信息' })).toBeVisible();

    await git.getByLabel('用户名').fill('Git E2E User');
    await git.getByLabel('邮箱').fill('git-e2e@example.com');
    await git.getByRole('button', { name: '保存 Git 设置' }).click();
    await expect(page.getByText(SAVE_TOAST)).toBeVisible({ timeout: 5000 });
    expect(mocked.updates[0]).toEqual({
      committerType: 'CUSTOM',
      customName: 'Git E2E User',
      customEmail: 'git-e2e@example.com',
      commitWithBot: false,
    });

    // 切回「未设置」→ 保存后服务端清空自定义字段
    await group.getByRole('radio', { name: '未设置' }).check();
    await expect(git.getByLabel('用户名')).toHaveCount(0);
    await git.getByRole('button', { name: '保存 Git 设置' }).click();
    await expect.poll(() => mocked.current().committerType).toBe('UNSET');
    expect(mocked.updates[1]).toEqual(EMPTY_SETTINGS);
    expect(mocked.current()).toEqual(EMPTY_SETTINGS);
  });

  test('E2E-GIT2: 导入Github帐号信息列出个人帐号（头像 + 帐号名）→ 回填并可继续编辑 → 保存', async ({
    page,
  }) => {
    const mocked = await mockGitGraphQL(page, {
      accounts: [FIRST_ACCOUNT, SECOND_ACCOUNT],
    });
    await openSettings(page);
    const git = gitSection(page);

    await committerTypeGroup(page).getByRole('radio', { name: '自定义' }).check();
    await git.getByRole('button', { name: '导入Github帐号信息' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: '导入Github帐号信息' }),
    ).toBeVisible();
    await expect(dialog.getByText('先到『GitHub 绑定』绑定帐号')).toHaveCount(0);

    const list = dialog.getByRole('list', { name: '个人 Github 帐号列表' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list.getByText(FIRST_ACCOUNT.githubLogin)).toBeVisible();
    await expect(list.getByText(SECOND_ACCOUNT.githubLogin)).toBeVisible();
    // 有头像时渲染 img（alt = "<login> 头像"），无头像时回退占位块
    const firstAvatar = list.getByRole('img', { name: `${FIRST_ACCOUNT.githubLogin} 头像` });
    await expect(firstAvatar).toHaveAttribute('src', AVATAR_DATA_URI);
    await expect(firstAvatar).toBeVisible();
    await expect(list.locator('img')).toHaveCount(1);

    // 选择第二个帐号 → 回填 用户名 = login，邮箱 = <githubUserId>+<login>@users.noreply.github.com
    await list.getByRole('button', { name: SECOND_ACCOUNT.githubLogin }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(git.getByLabel('用户名')).toHaveValue(SECOND_ACCOUNT.githubLogin);
    await expect(git.getByLabel('邮箱')).toHaveValue(
      `${SECOND_ACCOUNT.githubUserId}+${SECOND_ACCOUNT.githubLogin}@users.noreply.github.com`,
    );

    // 回填后可继续编辑，并以编辑后的值保存
    const editedEmail = 'edited-git-e2e@example.com';
    await git.getByLabel('邮箱').fill(editedEmail);
    await git.getByRole('button', { name: '保存 Git 设置' }).click();
    await expect(page.getByText(SAVE_TOAST)).toBeVisible({ timeout: 5000 });
    expect(mocked.current()).toEqual({
      committerType: 'CUSTOM',
      customName: SECOND_ACCOUNT.githubLogin,
      customEmail: editedEmail,
      commitWithBot: false,
    });
  });

  test('E2E-GIT2b: 未绑定个人 Github 帐号时导入弹窗展示空态引导', async ({ page }) => {
    await mockGitGraphQL(page, { accounts: [] });
    await openSettings(page);
    const git = gitSection(page);

    await committerTypeGroup(page).getByRole('radio', { name: '自定义' }).check();
    await git.getByRole('button', { name: '导入Github帐号信息' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('import-github-account-empty')).toHaveText(
      '先到『GitHub 绑定』绑定帐号',
    );
    await expect(dialog.getByRole('list', { name: '个人 Github 帐号列表' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '关闭' })).toBeVisible();

    // 空态下不改变已填写的提交人
    await expect(git.getByLabel('用户名')).toHaveValue('');
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('E2E-GIT3: 自定义提交人校验拦截（空用户名 / 非法邮箱）且不发起 mutation', async ({
    page,
  }) => {
    const mocked = await mockGitGraphQL(page);
    await openSettings(page);
    const git = gitSection(page);

    await committerTypeGroup(page).getByRole('radio', { name: '自定义' }).check();
    const save = git.getByRole('button', { name: '保存 Git 设置' });

    // 空用户名 + 合法邮箱
    await git.getByLabel('用户名').fill('');
    await git.getByLabel('邮箱').fill('git-e2e@example.com');
    await expect(git.getByText(INVALID_COMMITTER_MESSAGE)).toBeVisible();
    await expect(save).toBeDisabled();
    await save.click({ force: true });

    // 用户名合法 + 非法邮箱
    await git.getByLabel('用户名').fill('Git E2E User');
    await git.getByLabel('邮箱').fill('not-an-email');
    await expect(git.getByText(INVALID_COMMITTER_MESSAGE)).toBeVisible();
    await expect(save).toBeDisabled();
    await save.click({ force: true });

    // 空用户名 + 空邮箱
    await git.getByLabel('用户名').fill('');
    await git.getByLabel('邮箱').fill('');
    await expect(git.getByText(INVALID_COMMITTER_MESSAGE)).toBeVisible();
    await expect(save).toBeDisabled();

    // 校验期间从未发起 updateCommitSettings
    expect(mocked.updates).toEqual([]);
    expect(mocked.current()).toEqual(EMPTY_SETTINGS);

    // 修正后提示消失、保存恢复可用
    await git.getByLabel('用户名').fill('Git E2E User');
    await git.getByLabel('邮箱').fill('git-e2e@example.com');
    await expect(git.getByText(INVALID_COMMITTER_MESSAGE)).toHaveCount(0);
    await expect(save).toBeEnabled();
  });

  test('E2E-CB1: 「与 bot 共同提交」未设置时置灰，自定义勾选后保存并回显', async ({ page }) => {
    const mocked = await mockGitGraphQL(page);
    await openSettings(page);
    const git = gitSection(page);
    const checkbox = git.getByRole('checkbox', { name: '与 bot 共同提交' });

    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toBeDisabled();
    await expect(git.getByText('设置提交人后可勾选')).toBeVisible();

    await committerTypeGroup(page).getByRole('radio', { name: '自定义' }).check();
    await git.getByLabel('用户名').fill('Git E2E User');
    await git.getByLabel('邮箱').fill('git-e2e@example.com');
    await expect(checkbox).toBeEnabled();
    await expect(git.getByText('设置提交人后可勾选')).toHaveCount(0);
    await checkbox.check();
    await git.getByRole('button', { name: '保存 Git 设置' }).click();
    await expect(page.getByText(SAVE_TOAST)).toBeVisible({ timeout: 5000 });

    expect(mocked.updates[0]).toMatchObject({ commitWithBot: true });
    expect(mocked.current().commitWithBot).toBe(true);

    await page.reload();
    await expect(committerTypeGroup(page).getByRole('radio', { name: '自定义' })).toBeChecked();
    await expect(git.getByRole('checkbox', { name: '与 bot 共同提交' })).toBeChecked();
  });

  test('E2E-GIT4: 存量设置等价回显（GitHub login + noreply 邮箱）并与保存值一致', async ({
    page,
  }) => {
    // 旧「Github帐号」口径落库后转换得到的等价形态：用户名 = login，邮箱 = <id>+<login>@users.noreply.github.com
    const legacySettings: CommitSettingsFixture = {
      committerType: 'CUSTOM',
      customName: 'octocat',
      customEmail: '583231+octocat@users.noreply.github.com',
      commitWithBot: false,
    };
    const mocked = await mockGitGraphQL(page, { initialSettings: legacySettings });
    await openSettings(page);
    const git = gitSection(page);

    await expect(
      committerTypeGroup(page).getByRole('radio', { name: '自定义' }),
    ).toBeChecked();
    await expect(git.getByLabel('用户名')).toHaveValue(legacySettings.customName!);
    await expect(git.getByLabel('邮箱')).toHaveValue(legacySettings.customEmail!);
    await expect(git.getByText(INVALID_COMMITTER_MESSAGE)).toHaveCount(0);

    // 不改动直接保存 → 提交值与原回显完全一致（无隐式改写/裁剪）
    await git.getByRole('button', { name: '保存 Git 设置' }).click();
    await expect(page.getByText(SAVE_TOAST)).toBeVisible({ timeout: 5000 });
    expect(mocked.updates).toEqual([legacySettings]);
    expect(mocked.current()).toEqual(legacySettings);

    // 刷新后仍按同一份值回显（mutation refetch 不回退旧缓存）
    await page.reload();
    await expect(
      committerTypeGroup(page).getByRole('radio', { name: '自定义' }),
    ).toBeChecked();
    await expect(git.getByLabel('用户名')).toHaveValue(legacySettings.customName!);
    await expect(git.getByLabel('邮箱')).toHaveValue(legacySettings.customEmail!);
  });
});
