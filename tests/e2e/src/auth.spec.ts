import { test, expect } from '@playwright/test';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const TEST_PASS = 'testpass123';

const sidebar = () => 'nav[aria-label="Sidebar"]';
const cardTitle = () => '[data-slot="card-title"]';

async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>) {
  return page.request.post(API_URL, {
    headers: { 'Content-Type': 'application/json' },
    data: { query, variables },
  });
}

async function registerUser(page: import('@playwright/test').Page): Promise<string> {
  const username = `ea${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
  await gqlRequest(page, `
    mutation Signup($u: String!, $p: String!) {
      signup(username: $u, password: $p) { token user { id username } }
    }
  `, { u: username, p: TEST_PASS });
  return username;
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', TEST_PASS);
  await page.click('button[type="submit"]');
  await expect(page.locator(sidebar())).toBeVisible({ timeout: 10000 });
}

test.describe('Auth E2E', () => {

  test('should register a new user and redirect to main page', async ({ page }) => {
    const username = `er${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
    await page.goto('/register');
    await expect(page.locator(cardTitle())).toContainText('注册');

    await page.fill('#username', username);
    await page.fill('#password', TEST_PASS);
    await page.click('button[type="submit"]');

    await expect(page.locator(sidebar())).toBeVisible({ timeout: 10000 });
  });

  test('should login with existing credentials and show main layout', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await expect(page.locator(sidebar()).getByText('会话')).toBeVisible();
  });

  test('should show username in sidebar after login', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await expect(page.locator(sidebar()).getByText(username)).toBeVisible({ timeout: 10000 });
  });

  test('should show error for wrong password', async ({ page }) => {
    const username = await registerUser(page);
    await page.goto('/login');
    await page.fill('#username', username);
    await page.fill('#password', 'wrongpass');
    await page.click('button[type="submit"]');

    await expect(page.getByText(/Invalid username|密码|认证/)).toBeVisible({ timeout: 5000 });
  });

  test('should navigate to settings page via settings button', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);

    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });
  });

  test('should display settings page with 2-column layout', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);

    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('个人资料')).toBeVisible();
  });

  test('should logout and redirect to login page', async ({ page }) => {
    const username = await registerUser(page);
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
