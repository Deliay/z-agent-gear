import { expect, test } from '@playwright/test';
import { createFrontUser, FRONT_USER_PASSWORD } from './helpers.js';
import {
  providerButtonName,
  setupOAuthFixture,
  type OAuthFixture,
} from './auth-oauth-helpers.js';

/**
 * 外部身份首次登录身份选择与设置页绑定管理（#510，E2E-OBO1~7）。
 *
 * 依赖 Aspire 全量服务 + fake OIDC（进程内 19419）；GitHub 绑定用例额外要求
 * agent-api 的 `GITHUB_OAUTH_*` 指向进程内 mock（否则显式 skip）。
 */
test.describe.serial('OIDC 绑定优化', () => {
  let fixture: OAuthFixture;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    fixture = await setupOAuthFixture(page);
    await page.close();
  });

  test.afterAll(async () => {
    await fixture?.dispose();
  });

  function useNewIdentity(label: string): string {
    const sub = `${fixture.subject}-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    fixture.oidc.setClaims({
      sub,
      preferred_username: `e2e${label}${Date.now().toString(36)}`.slice(0, 20),
      name: `E2E ${label}`,
      email: `${sub}@example.com`,
    });
    return sub;
  }

  async function startOidcLogin(page: import('@playwright/test').Page) {
    await page.goto('/login');
    await page.getByRole('button', {
      name: providerButtonName('oidc', fixture.providerName),
    }).click();
    await page.waitForURL(/\/login\/identity-choice/, { timeout: 30000 });
  }

  async function bindExisting(page: import('@playwright/test').Page, username: string) {
    await page.getByLabel('用户名').fill(username);
    await page.getByLabel('密码').fill(FRONT_USER_PASSWORD);
    await page.getByRole('button', { name: '绑定并登录' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
  }

  async function createNew(page: import('@playwright/test').Page) {
    await page.getByRole('button', { name: '创建新帐号' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
  }

  async function currentUserId(page: import('@playwright/test').Page): Promise<string> {
    const raw = await page.evaluate(() => localStorage.getItem('auth_user'));
    expect(raw).toBeTruthy();
    return (JSON.parse(raw as string) as { id: string }).id;
  }

  test('E2E-OBO1 已有密码账户首登 → 身份选择摘要 → 绑定已有帐号进入原账户', async ({ page }) => {
    useNewIdentity('obo1');
    const user = await createFrontUser(page, { prefix: 'obo1' });

    await startOidcLogin(page);
    await expect(page.getByText(fixture.providerName)).toBeVisible();
    await expect(page.getByText(/外部帐号/)).toBeVisible();

    await bindExisting(page, user.username);
    expect(await currentUserId(page)).toBe(user.userId);

    // 设置页可见绑定列表
    await page.goto('/settings');
    const section = page.getByTestId('external-login-binding-section');
    await expect(section).toBeVisible();
    await expect(section.getByText(fixture.providerName)).toBeVisible();
  });

  test('E2E-OBO2 新身份选择「创建新帐号」→ 进入新账户', async ({ page }) => {
    useNewIdentity('obo2');
    await startOidcLogin(page);
    await createNew(page);
    expect(await currentUserId(page)).toBeTruthy();
  });

  test('E2E-OBO3 验密失败提示可重试（不消耗身份选择上下文）', async ({ page }) => {
    useNewIdentity('obo3');
    const user = await createFrontUser(page, { prefix: 'obo3' });

    await startOidcLogin(page);
    await page.getByLabel('用户名').fill(user.username);
    await page.getByLabel('密码').fill('wrong-password');
    await page.getByRole('button', { name: '绑定并登录' }).click();
    await expect(page.getByRole('alert')).toContainText('Invalid username or password');

    await page.getByLabel('密码').fill(FRONT_USER_PASSWORD);
    await page.getByRole('button', { name: '绑定并登录' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
    expect(await currentUserId(page)).toBe(user.userId);
  });

  test('E2E-OBO4 设置页查看绑定 + 对第二 provider 发起绑定', async ({ page }) => {
    useNewIdentity('obo4');
    const user = await createFrontUser(page, { prefix: 'obo4' });
    await startOidcLogin(page);
    await bindExisting(page, user.username);

    await page.goto('/settings');
    const section = page.getByTestId('external-login-binding-section');
    await expect(section.getByTestId('external-login-row')).toHaveCount(1);

    const authorizeEnv = process.env.GITHUB_OAUTH_AUTHORIZE_URL ?? '';
    test.skip(
      !fixture.githubProviderId || !authorizeEnv.includes('19418'),
      'agent-api 未配置 fake GitHub / GitHub provider 不可用',
    );
    fixture.github.setOAuthUser({
      id: Number(`7${Date.now().toString().slice(-8)}`),
      login: `obo4gh${Date.now().toString(36)}`.slice(0, 20),
      name: 'OBO4 GitHub',
    });
    await section.getByRole('button', { name: '绑定 GitHub' }).click();
    await page.waitForURL(/\/settings/, { timeout: 30000 });
    await expect(page.getByRole('status')).toContainText('第三方登录绑定成功');
    await expect(page.getByTestId('external-login-row')).toHaveCount(2);
  });

  test('E2E-OBO5 解绑二次确认生效 → 列表移除', async ({ page }) => {
    useNewIdentity('obo5');
    const user = await createFrontUser(page, { prefix: 'obo5' });
    await startOidcLogin(page);
    await bindExisting(page, user.username);

    await page.goto('/settings');
    const section = page.getByTestId('external-login-binding-section');
    const row = section.getByTestId('external-login-row').first();
    await row.getByRole('button', { name: '解绑' }).click();
    await expect(
      page.getByText('确定要解绑该第三方登录方式吗？解绑后该身份将无法再登录当前账户。'),
    ).toBeVisible();
    await page.getByRole('button', { name: '解绑' }).last().click();
    await expect(section.getByTestId('external-login-row')).toHaveCount(0, { timeout: 15000 });
    await expect(section.getByText('暂无绑定第三方登录方式')).toBeVisible();
  });

  test('E2E-OBO6 无密码账户仅剩一条绑定时解绑被拒', async ({ page }) => {
    useNewIdentity('obo6');
    await startOidcLogin(page);
    await createNew(page);

    await page.goto('/settings');
    const section = page.getByTestId('external-login-binding-section');
    await section.getByRole('button', { name: '解绑' }).first().click();
    await page.getByRole('button', { name: '解绑' }).last().click();
    await expect(section.getByRole('alert')).toContainText('这是账户唯一的登录方式');
    await expect(section.getByTestId('external-login-row')).toHaveCount(1);
  });

  test('E2E-OBO7 完成绑定后再次第三方登录直登（不再出现选择页）', async ({ page }) => {
    useNewIdentity('obo7');
    await startOidcLogin(page);
    await createNew(page);
    const userId = await currentUserId(page);

    await page.goto('/login');
    await page.getByRole('button', {
      name: providerButtonName('oidc', fixture.providerName),
    }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
    expect(await currentUserId(page)).toBe(userId);
  });
});
