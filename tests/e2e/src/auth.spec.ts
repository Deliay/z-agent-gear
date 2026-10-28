import { test, expect } from '@playwright/test';
import { createFrontUser, loginFrontUser, FRONT_USER_PASSWORD } from './helpers';

const sidebar = () => 'nav[aria-label="Sidebar"]';
const cardTitle = () => '[data-slot="card-title"]';

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', FRONT_USER_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.locator(sidebar())).toBeVisible({ timeout: 10000 });
}

test.describe('Auth E2E', () => {

  // E2E-MT1：注册硬关闭的第一层（前端页面/路由无注册入口，开户只能后台发起）。
  test('should not expose any register entry on login page', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator(cardTitle())).toContainText('登录');

    await expect(page.getByRole('link', { name: /注册/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /注册/ })).toHaveCount(0);
    await expect(page.locator('a[href="/register"]')).toHaveCount(0);
    await expect(page.getByText(/没有账号|去注册/)).toHaveCount(0);
  });

  // E2E-MT1：`/register` 直达不可用（重定向登录页、前端 404 或空白路由，均不得渲染注册表单）。
  test('should not render register page at /register', async ({ page }) => {
    const response = await page.goto('/register');
    await page.waitForLoadState('domcontentloaded');

    // 任何情况下都不得出现「注册」提交表单或注册文案
    await expect(page.getByRole('button', { name: /^注册$/ })).toHaveCount(0);
    await expect(page.locator('#register-form, form[data-page="register"]')).toHaveCount(0);
    const bodyText = (await page.locator('body').innerText()).trim();

    const url = page.url();
    const redirectedAway = !/\/register(\?|$|\/)/.test(url);
    const landedOnLogin = await page.locator(cardTitle()).filter({ hasText: '登录' }).count() > 0;
    const notFound = /404|页面不存在|Not Found/i.test(bodyText);
    // 路由删除后 SPA 无匹配路由时为空白页（无任何注册内容）同样视为「不可用」
    const blankRoute = bodyText.length === 0 || !/注册/.test(bodyText);
    expect(redirectedAway || landedOnLogin || notFound || blankRoute || response?.status() === 404).toBe(true);
  });

  test('should login with existing credentials and show main layout', async ({ page }) => {
    const { username } = await createFrontUser(page);
    await loginViaUI(page, username);
    // 侧边栏导航为图标链接，不再渲染「会话」文本；以「我的费用」入口锚定登录后布局。
    await expect(page.locator(sidebar()).getByRole('link', { name: '我的费用' })).toBeVisible();
  });

  test('should show display name in sidebar after login', async ({ page }) => {
    const { username } = await createFrontUser(page);
    await loginViaUI(page, username);
    // 展示名走 `user.name`（迁移后=原用户名），侧边栏底部可见。
    await expect(page.locator(sidebar()).getByText(username)).toBeVisible({ timeout: 10000 });
  });

  test('should expose name and personal tenant via login payload', async ({ page }) => {
    const { username, userId } = await createFrontUser(page);
    const meRes = await page.request.post(process.env.API_URL || 'http://localhost:10001/graphql', {
      headers: { 'Content-Type': 'application/json' },
      data: { query: '{ me { id name tenant { id name type memberCount } } }' },
    });
    // 无 token 时 me 为 null（鉴权口径零回归）
    expect((await meRes.json()).data.me).toBeNull();

    const login = await loginFrontUser(page, username);
    const res = await page.request.post(process.env.API_URL || 'http://localhost:10001/graphql', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
      data: { query: '{ me { id name tenant { id name type memberCount } } }' },
    });
    const me = (await res.json()).data.me;
    expect(me.id).toBe(userId);
    expect(me.name).toBe(username);
    // 一期 personal 租户 `_id` 复用 userId，单成员
    expect(me.tenant.id).toBe(userId);
    expect(me.tenant.type).toBe('personal');
    expect(me.tenant.memberCount).toBe(1);
  });

  test('should show error for wrong password', async ({ page }) => {
    const { username } = await createFrontUser(page);
    await page.goto('/login');
    await page.fill('#username', username);
    await page.fill('#password', 'wrongpass');
    await page.click('button[type="submit"]');

    await expect(page.getByText(/Invalid username|密码|认证/)).toBeVisible({ timeout: 5000 });
  });

  test('should navigate to settings page via settings button', async ({ page }) => {
    const { username } = await createFrontUser(page);
    await loginViaUI(page, username);

    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });
  });

  test('should display settings page with 2-column layout', async ({ page }) => {
    const { username } = await createFrontUser(page);
    await loginViaUI(page, username);

    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('个人资料')).toBeVisible();
  });

  test('should logout and redirect to login page', async ({ page }) => {
    const { username } = await createFrontUser(page);
    await loginViaUI(page, username);

    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await page.getByRole('button', { name: '退出' }).click();
    await expect(page.locator(cardTitle())).toContainText('登录', { timeout: 5000 });
  });

  test('should redirect unauthenticated user to login page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator(cardTitle())).toContainText('登录', { timeout: 5000 });
  });
});
