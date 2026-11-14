import { expect, test } from '@playwright/test';
import {
  providerButtonName,
  setOidcEnabled,
  setupOAuthFixture,
  type OAuthFixture,
} from './auth-oauth-helpers.js';

/**
 * 前台第三方登录 E2E（E2E-OIDC1~3 / E2E-GH1）。
 *
 * 依赖：Aspire 全量服务（agent-web / agent-api / admin-api / Redis / Mongo）+
 * `INTERNAL_API_TOKEN`（admin 口令归一化可能用到）+ `MONGODB_URI`。
 * fake OIDC 由本进程启动（19419）；GitHub 需 agent-api 指向进程内 mock（19418），
 * 否则 E2E-GH1 显式 skip。
 */
test.describe.serial('前台第三方登录', () => {
  let fixture: OAuthFixture;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    fixture = await setupOAuthFixture(page);
    await page.close();
  });

  test.afterAll(async () => {
    await fixture?.dispose();
  });

  test('E2E-OIDC1 登录页按钮随启停即时增减', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', {
      name: providerButtonName('oidc', fixture.providerName),
    })).toBeVisible({ timeout: 15000 });

    await setOidcEnabled(page, fixture.adminToken, fixture.oidcProviderId, false);
    await page.reload();
    await expect(page.getByRole('button', {
      name: providerButtonName('oidc', fixture.providerName),
    })).toHaveCount(0, { timeout: 15000 });

    await setOidcEnabled(page, fixture.adminToken, fixture.oidcProviderId, true);
    await page.reload();
    await expect(page.getByRole('button', {
      name: providerButtonName('oidc', fixture.providerName),
    })).toBeVisible({ timeout: 15000 });
  });

  test('E2E-OIDC2 完整重定向登录并自动开户', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', {
      name: providerButtonName('oidc', fixture.providerName),
    }).click();

    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
    const token = await page.evaluate(() => localStorage.getItem('auth_token'));
    expect(token).toBeTruthy();
    const user = await page.evaluate(() => localStorage.getItem('auth_user'));
    expect(user).toBeTruthy();
  });

  test('E2E-OIDC3 取消授权回登录页并提示已取消', async ({ page }) => {
    fixture.oidc.denyNext();
    await page.goto('/login');
    await page.getByRole('button', {
      name: providerButtonName('oidc', fixture.providerName),
    }).click();

    await page.waitForURL(/\/login\?error=access_denied/, { timeout: 30000 });
    await expect(page.getByRole('alert')).toContainText('已取消授权');
  });

  test('E2E-GH1 GitHub 登录链路（需 agent-api 指向 fake GitHub）', async ({ page }) => {
    const authorizeEnv = process.env.GITHUB_OAUTH_AUTHORIZE_URL ?? '';
    test.skip(!authorizeEnv.includes('19418'), 'agent-api 未配置 GITHUB_OAUTH_AUTHORIZE_URL 指向 fake');

    fixture.github.setOAuthUser({
      id: 5005,
      login: `gh${Date.now().toString(36)}`.slice(0, 20),
      name: 'GitHub E2E',
    });
    await page.goto('/login');
    await page.getByRole('button', { name: /使用 GitHub 登录/ }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
    expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBeTruthy();
  });
});
