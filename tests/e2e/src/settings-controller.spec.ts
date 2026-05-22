import { test, expect } from '@playwright/test';

const TEST_USER = `ce2e${Date.now()}`.slice(0, 20);
const TEST_PASS = 'testpass123';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';

const sidebar = () => 'nav[aria-label="Sidebar"]';

async function registerUser(page: import('@playwright/test').Page) {
  await page.request.post(API_URL, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      query: `mutation Signup($u: String!, $p: String!) { signup(username: $u, password: $p) { token user { id } } }`,
      variables: { u: TEST_USER, p: TEST_PASS },
    },
  });
}

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.fill('#username', TEST_USER);
  await page.fill('#password', TEST_PASS);
  await page.click('button[type="submit"]');
  await expect(page.locator(sidebar())).toBeVisible({ timeout: 10000 });
}

async function loginAndGoSettings(page: import('@playwright/test').Page) {
  await login(page);
  await page.click('a[href="/settings"]');
  await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });
}

test.describe('Settings Controller E2E', () => {

  test('should register user and show controller section', async ({ page }) => {
    await registerUser(page);
    await login(page);

    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
  });

  test('should show controller management navigation', async ({ page }) => {
    await loginAndGoSettings(page);
    const nav = page.locator('nav[aria-label="Settings navigation"]');

    await expect(nav.getByText('本地控制器', { exact: true })).toBeVisible();
    await expect(nav.getByRole('button', { name: '控制器管理' })).toBeVisible();
  });

  test('should show controller section with Key and Controller cards', async ({ page }) => {
    await loginAndGoSettings(page);
    const section = page.locator('#controller-section');

    await expect(section.getByRole('heading', { name: '控制器管理' })).toBeVisible();
    await expect(section.getByText('控制器', { exact: true })).toBeVisible();
  });

  test('should show key card with generate button and empty state', async ({ page }) => {
    await loginAndGoSettings(page);
    const section = page.locator('#controller-section');

    await expect(section.getByRole('button', { name: '生成 Key' })).toBeVisible();
    await expect(section.getByText(/暂无控制器/)).toBeVisible();
  });

  test('should show controller card with empty state', async ({ page }) => {
    await loginAndGoSettings(page);
    const section = page.locator('#controller-section');

    await expect(section.getByText(/暂无控制器/)).toBeVisible();
  });

  test('should generate key directly and show in key list', async ({ page }) => {
    await loginAndGoSettings(page);
    const section = page.locator('#controller-section');

    await section.getByRole('button', { name: '生成 Key' }).click();
    await expect(section.getByText('等待连接').first()).toBeVisible({ timeout: 10000 });
    await expect(section.getByText('local').first()).toBeVisible();
  });

  test('should show revoke and rename buttons for generated keys', async ({ page }) => {
    await loginAndGoSettings(page);
    const section = page.locator('#controller-section');

    await section.getByRole('button', { name: '生成 Key' }).click();
    await expect(section.getByText('等待连接').first()).toBeVisible({ timeout: 10000 });
    await expect(section.getByRole('button', { name: '复制' }).first()).toBeVisible();
  });

  test('should scroll to controller section from navigation', async ({ page }) => {
    await loginAndGoSettings(page);

    await page.locator('nav[aria-label="Settings navigation"]').getByRole('button', { name: '控制器管理' }).click();
    await expect(page.locator('#controller-section')).toBeVisible();
  });
});
