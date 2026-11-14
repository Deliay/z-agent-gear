import { expect, test } from '@playwright/test';
import {
  ADMIN_WEB_URL,
  adminGqlRequest,
  adminLoginViaUI,
} from './helpers.js';
import {
  clearAdminAuth,
  providerButtonName,
  setupOAuthFixture,
  type OAuthFixture,
} from './auth-oauth-helpers.js';

/**
 * 后台第三方登录 E2E（E2E-AD-OA1~4）。
 *
 * 依赖：admin-web / admin-api / agent-api / agent-web / Redis / Mongo 就绪；
 * fake OIDC 19419 由本进程启动。管理员口令经 helpers 归一化（需 MONGODB_URI 或已知初始口令）。
 */
test.describe.serial('后台第三方登录', () => {
  let fixture: OAuthFixture;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    fixture = await setupOAuthFixture(page);
    await page.close();
  });

  test.afterAll(async () => {
    await fixture?.dispose();
  });

  test('E2E-AD-OA1 「登录认证」配置 CRUD，secret 创建后不可见', async ({ page }) => {
    await adminLoginViaUI(page);
    await page.goto(`${ADMIN_WEB_URL}/auth-providers`);

    const name = `UI OIDC ${Date.now()}`;
    const secret = `ui-secret-${Date.now()}`;
    await page.getByRole('button', { name: '新增 OIDC Provider' }).click();
    await page.locator('#oidc-name').fill(name);
    await page.locator('#oidc-issuer').fill(fixture.oidc.issuer);
    await page.locator('#oidc-client-id').fill('ui-client');
    await page.locator('#oidc-secret').fill(secret);
    await page.locator('#oidc-scopes').fill('openid profile email');
    await page.getByRole('button', { name: '保存', exact: true }).click();

    await expect(page.getByText(name)).toBeVisible();
    await expect(page.getByText('Secret: 已设置').first()).toBeVisible();
    expect(await page.content()).not.toContain(secret);

    await page.reload();
    const card = page.locator('div').filter({ hasText: name }).last();
    await expect(card.getByRole('button', { name: '编辑' })).toBeVisible();
    await card.getByRole('button', { name: '编辑' }).click();
    await expect(page.locator('#oidc-secret')).toHaveValue('');
    await expect(page.locator('#oidc-secret')).toHaveAttribute('placeholder', '已设置（留空保持不变）');
    await page.getByRole('button', { name: '取消' }).click();

    // 清理本用例创建的额外 Provider
    const listRes = await adminGqlRequest(
      page,
      `query { oidcProviders { id displayName } }`,
      undefined,
      fixture.adminToken,
    );
    const listBody = await listRes.json();
    const created = (listBody.data?.oidcProviders ?? []).find(
      (item: { displayName: string }) => item.displayName === name,
    );
    if (created) {
      await adminGqlRequest(
        page,
        'mutation D($id: ID!) { deleteOidcProvider(id: $id) }',
        { id: created.id },
        fixture.adminToken,
      );
    }
  });

  test('E2E-AD-OA2 绑定外部身份 → 后台第三方登录进入后台', async ({ page }) => {
    await adminLoginViaUI(page);
    await page.goto(`${ADMIN_WEB_URL}/settings/security`);

    await page
      .locator('div')
      .filter({ hasText: fixture.providerName })
      .getByRole('button', { name: '绑定' })
      .click();
    await page.waitForURL(/\/settings\/security\?bind=success/, { timeout: 30000 });
    await expect(page.getByText('外部身份绑定成功')).toBeVisible();
    await expect(page.getByText(/·/)).toBeVisible();

    await clearAdminAuth(page);
    await page.goto(`${ADMIN_WEB_URL}/login`);
    await page.getByRole('button', {
      name: providerButtonName('oidc', fixture.providerName),
    }).click();
    await page.waitForURL(/\/(models|change-password)/, { timeout: 30000 });
    expect(await page.evaluate(() => localStorage.getItem('admin_token'))).toBeTruthy();
  });

  test('E2E-AD-OA3 未绑定身份后台登录被拒并提示', async ({ page }) => {
    fixture.oidc.setClaims({
      sub: `unbound-${Date.now()}`,
      preferred_username: `unbound${Date.now().toString(36)}`.slice(0, 20),
      name: 'Unbound User',
      email: `unbound-${Date.now()}@example.com`,
    });
    await clearAdminAuth(page);
    await page.goto(`${ADMIN_WEB_URL}/login`);
    await page.getByRole('button', {
      name: providerButtonName('oidc', fixture.providerName),
    }).click();
    await page.waitForURL(/\/login\?error=not_bound/, { timeout: 30000 });
    await expect(page.getByRole('alert')).toContainText('该身份未绑定任何管理员账户');
  });

  test('E2E-AD-OA4 解绑后立即无法登录', async ({ page }) => {
    await adminLoginViaUI(page);
    await page.goto(`${ADMIN_WEB_URL}/settings/security`);

    const row = page.locator('div').filter({ hasText: fixture.providerName }).last();
    await row.getByRole('button', { name: '解绑' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('解绑后将无法再使用该身份登录后台');
    await dialog.getByRole('button', { name: '解绑' }).click();
    await expect(page.getByText('已解绑')).toBeVisible();

    fixture.oidc.setClaims({
      sub: fixture.subject,
      preferred_username: `e2e${Date.now().toString(36)}`.slice(0, 20),
      name: 'E2E OIDC User',
      email: `e2e-${Date.now()}@example.com`,
    });
    await clearAdminAuth(page);
    await page.goto(`${ADMIN_WEB_URL}/login`);
    await page.getByRole('button', {
      name: providerButtonName('oidc', fixture.providerName),
    }).click();
    await page.waitForURL(/\/login\?error=not_bound/, { timeout: 30000 });
  });
});
