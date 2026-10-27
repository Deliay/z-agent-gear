import { test, expect, type Page } from '@playwright/test';
import { registerUser, loginViaUI } from './helpers.js';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';

interface CommitSettingsFixture {
  committerMode: 'AGENT_ONLY' | 'CO_AUTHOR' | 'HUMAN_ONLY' | 'UNSET';
  committerType: 'GITHUB_ACCOUNT' | 'CUSTOM' | 'UNSET';
  githubAccountId: string | null;
  customName: string | null;
  customEmail: string | null;
}

const EMPTY_SETTINGS: CommitSettingsFixture = {
  committerMode: 'UNSET',
  committerType: 'UNSET',
  githubAccountId: null,
  customName: null,
  customEmail: null,
};

const ACCOUNT = {
  id: 'mock-acc-1',
  githubUserId: 12345,
  githubLogin: 'e2e-commit-user',
  githubAvatarUrl: null,
  installations: [],
  createdAt: '2026-01-01T00:00:00Z',
};

/**
 * 拦截 Commit 设置相关 GraphQL（其余请求透传）：
 * - GetGithubAccounts / GetCommitSettings / UpdateCommitSettings
 * - 服务端状态保存在闭包内，模拟「保存后回读一致」。
 */
async function mockCommitGraphQL(
  page: Page,
  options: { accounts?: Array<typeof ACCOUNT>; serverError?: string } = {},
): Promise<{ current: () => CommitSettingsFixture }> {
  let settings: CommitSettingsFixture = { ...EMPTY_SETTINGS };

  await page.route(API_URL, async (route) => {
    const postData = route.request().postDataJSON() as {
      query?: string;
      variables?: { input?: Partial<CommitSettingsFixture> };
    } | null;
    const query = postData?.query ?? '';

    if (query.includes('GetGithubAccounts')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: { githubAccounts: options.accounts ?? [ACCOUNT] } }),
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
      settings = {
        committerMode: input.committerMode ?? 'UNSET',
        committerType: input.committerType ?? 'UNSET',
        githubAccountId: input.githubAccountId ?? null,
        customName: input.customName ?? null,
        customEmail: input.customEmail ?? null,
      };
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: { updateCommitSettings: settings } }),
      });
      return;
    }

    await route.continue();
  });

  return { current: () => settings };
}

async function openSettings(page: Page): Promise<void> {
  const { username } = await registerUser(page);
  await loginViaUI(page, username);
  await page.click('a[href="/settings"]');
  await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });
}

function section(page: Page) {
  return page.locator('#github-section');
}

test.describe('Settings Commit Author E2E', () => {
  test('E2E-1: 展示 Commit 设置区块与常驻提示，四种模式 / 三种提交人可切换并保存', async ({
    page,
  }) => {
    await mockCommitGraphQL(page);
    await openSettings(page);

    const commit = section(page).getByTestId('commit-settings-section');
    const modeGroup = commit.getByRole('radiogroup', { name: '提交人模式' });
    const typeGroup = commit.getByRole('radiogroup', { name: '提交人' });
    await expect(commit.getByRole('heading', { name: 'Commit 设置' })).toBeVisible();
    await expect(commit.getByText('设置只对云容器环境生效')).toBeVisible();
    await expect(modeGroup.getByRole('radio', { name: '未设置' })).toBeChecked();

    for (const label of ['仅Agent', 'Co-Author', '仅人类', '未设置']) {
      await expect(modeGroup.getByRole('radio', { name: label })).toBeVisible();
    }
    for (const label of ['Github帐号', '自定义', '未设置']) {
      await expect(typeGroup.getByRole('radio', { name: label })).toBeVisible();
    }

    await modeGroup.getByRole('radio', { name: 'Co-Author' }).check();
    await typeGroup.getByRole('radio', { name: 'Github帐号' }).check();
    await commit.getByLabel('Github 帐号').selectOption(ACCOUNT.id);
    await expect(commit.getByLabel('Github 帐号')).toHaveValue(ACCOUNT.id);
    await commit.getByRole('button', { name: '保存 Commit 设置' }).click();
    await expect(
      page.getByText('对云容器环境生效，已运行的云电脑稍后自动更新'),
    ).toBeVisible({ timeout: 5000 });
  });

  test('E2E-2: 联动拦截 —— Co-Author / 仅人类 + 提交人未设置禁用保存并提示', async ({
    page,
  }) => {
    await mockCommitGraphQL(page);
    await openSettings(page);
    const commit = section(page).getByTestId('commit-settings-section');

    await commit.getByRole('radio', { name: 'Co-Author' }).check();
    await expect(commit.getByText('请先设置提交人')).toBeVisible();
    await expect(commit.getByRole('button', { name: '保存 Commit 设置' })).toBeDisabled();

    await commit.getByRole('radio', { name: '仅人类' }).check();
    await expect(commit.getByRole('button', { name: '保存 Commit 设置' })).toBeDisabled();

    await commit.getByRole('radio', { name: '自定义' }).check();
    await commit.getByLabel('用户名').fill('');
    await commit.getByLabel('邮箱').fill('not-an-email');
    await expect(commit.getByText('提交人用户名或邮箱格式不正确')).toBeVisible();
    await expect(commit.getByRole('button', { name: '保存 Commit 设置' })).toBeDisabled();
  });

  test('E2E-3: 提交人条件渲染（帐号下拉 / 自定义输入 / 未绑定引导）', async ({ page }) => {
    await mockCommitGraphQL(page);
    await openSettings(page);
    const commit = section(page).getByTestId('commit-settings-section');

    await commit.getByRole('radio', { name: 'Github帐号' }).check();
    const select = commit.getByLabel('Github 帐号');
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveCount(2); // 占位 + 1 个已绑定帐号
    await expect(select.locator('option', { hasText: ACCOUNT.githubLogin })).toHaveCount(1);
    await expect(select.locator('option', { hasText: 'org' })).toHaveCount(0);

    await commit.getByRole('radio', { name: '自定义' }).check();
    await expect(commit.getByLabel('用户名')).toBeVisible();
    await expect(commit.getByLabel('邮箱')).toBeVisible();

    await page.unroute(API_URL);
    await mockCommitGraphQL(page, { accounts: [] });
    await page.reload();
    await expect(commit.getByRole('radio', { name: 'Github帐号' }).isChecked()).resolves.toBe(false);
    await commit.getByRole('radio', { name: 'Github帐号' }).check();
    await expect(commit.getByText('请先绑定 Github 帐号')).toBeVisible();
    await expect(commit.getByRole('button', { name: '保存 Commit 设置' })).toBeDisabled();
  });

  test('E2E-4: 双未设置保存 / 刷新回显一致（未设置零回归）', async ({ page }) => {
    const mocked = await mockCommitGraphQL(page);
    await openSettings(page);
    const commit = section(page).getByTestId('commit-settings-section');

    await expect(commit.getByRole('radio', { name: '未设置' }).first()).toBeChecked();
    await expect(commit.getByRole('radio', { name: '未设置' }).nth(1)).toBeChecked();

    await commit.getByRole('button', { name: '保存 Commit 设置' }).click();
    await expect(
      page.getByText('对云容器环境生效，已运行的云电脑稍后自动更新'),
    ).toBeVisible({ timeout: 5000 });
    expect(mocked.current()).toEqual(EMPTY_SETTINGS);

    await page.reload();
    await expect(commit.getByRole('radio', { name: '未设置' }).first()).toBeChecked();
    await expect(commit.getByRole('radio', { name: '未设置' }).nth(1)).toBeChecked();
  });
});
