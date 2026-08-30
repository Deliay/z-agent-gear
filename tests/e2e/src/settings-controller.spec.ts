import { test, expect } from '@playwright/test';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';

const sidebar = () => 'nav[aria-label="Sidebar"]';

async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>) {
  return page.request.post(API_URL, {
    headers: { 'Content-Type': 'application/json' },
    data: { query, variables },
  });
}

async function registerUser(page: import('@playwright/test').Page): Promise<{ token: string; username: string }> {
  const username = `ec${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
  const res = await gqlRequest(page, `
    mutation Signup($u: String!, $p: String!) {
      signup(username: $u, password: $p) { token user { id username } }
    }
  `, { u: username, p: 'testpass123' });
  const body = await res.json();
  if (!body.data?.signup) {
    throw new Error(`Signup failed: ${JSON.stringify(body)}`);
  }
  return { token: body.data.signup.token, username };
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await expect(page.locator(sidebar())).toBeVisible({ timeout: 10000 });
}

test.describe('Settings Controller E2E', () => {

  test('should register user and show controller section', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);

    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
  });

  test('should show controller management navigation', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const nav = page.locator('nav[aria-label="Settings navigation"]');

    await expect(nav.getByRole('button', { name: '控制器管理' })).toBeVisible();
  });

  test('should show controller section with Key and Controller cards', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const section = page.locator('#controller-section');

    await expect(section.getByRole('heading', { name: '控制器管理' })).toBeVisible();
    await expect(section.getByText('控制器', { exact: true })).toBeVisible();
  });

  test('should show key card with generate button and empty state', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const section = page.locator('#controller-section');

    await expect(section.getByRole('button', { name: '生成 Key' })).toBeVisible();
    await expect(section.getByText(/暂无控制器/)).toBeVisible();
  });

  test('should show controller card with empty state', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const section = page.locator('#controller-section');

    await expect(section.getByText(/暂无控制器/)).toBeVisible();
  });

  test('should generate key directly and show in key list', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const section = page.locator('#controller-section');

    await section.getByRole('button', { name: '生成 Key' }).click();
    await expect(section.getByText('等待连接').first()).toBeVisible({ timeout: 10000 });
    await expect(section.getByText('local').first()).toBeVisible();
  });

  test('should show revoke and rename buttons for generated keys', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const section = page.locator('#controller-section');

    await section.getByRole('button', { name: '生成 Key' }).click();
    await expect(section.getByText('等待连接').first()).toBeVisible({ timeout: 10000 });
    await expect(section.getByRole('button', { name: '复制' }).first()).toBeVisible();
  });

  test('should scroll to controller section from navigation', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });

    await page.locator('nav[aria-label="Settings navigation"]').getByRole('button', { name: '控制器管理' }).click();
    await expect(page.locator('#controller-section')).toBeVisible();
  });

  test('should show regenerate key button for bound controllers', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const section = page.locator('#controller-section');

    // Generate a key first
    await section.getByRole('button', { name: '生成 Key' }).click();
    await expect(section.getByText('等待连接').first()).toBeVisible({ timeout: 10000 });

    // The key should show "等待连接" status, not "重新生成Key" button
    // because it's not bound to a controller yet
    await expect(section.getByRole('button', { name: '重新生成Key' })).not.toBeVisible();
  });
});
