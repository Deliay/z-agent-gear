import { test, expect } from '@playwright/test';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const TEST_PASS = 'testpass123';

async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>) {
  return page.request.post(API_URL, {
    headers: { 'Content-Type': 'application/json' },
    data: { query, variables },
  });
}

async function registerUser(page: import('@playwright/test').Page): Promise<string> {
  const username = `ll${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
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
  await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
}

test.describe('Settings LLM Provider & Model E2E', () => {

  test('should show model settings navigation and sections', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    const nav = page.locator('nav[aria-label="Settings navigation"]');

    await expect(nav.getByRole('button', { name: '帐号' })).toBeVisible();
    await expect(nav.getByText('模型设置')).toBeVisible();
    await expect(nav.getByRole('button', { name: '供应商设置' })).toBeVisible();
    await expect(nav.getByRole('button', { name: '可用模型' })).toBeVisible();

    await expect(page.locator('#provider-section')).toBeVisible();
    await expect(page.locator('#model-section')).toBeVisible();
  });

  test('should scroll to provider section when clicking nav item', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.locator('nav[aria-label="Settings navigation"]').getByRole('button', { name: '供应商设置' }).click();
    await expect(page.locator('#provider-section')).toBeVisible();
  });

  test('should scroll to model section when clicking nav item', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.locator('nav[aria-label="Settings navigation"]').getByRole('button', { name: '可用模型' }).click();
    await expect(page.locator('#model-section')).toBeVisible();
  });

  test('should show provider section with add button and empty state', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    const section = page.locator('#provider-section');
    await expect(section.getByText('供应商设置')).toBeVisible();
    await expect(section.getByRole('button', { name: '添加供应商' })).toBeVisible();
    await expect(section.getByText(/暂无供应商/)).toBeVisible();
  });

  test('should open add provider dialog on button click', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.locator('#provider-section').getByRole('button', { name: '添加供应商' }).click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: '添加供应商' })).toBeVisible();
    await expect(page.getByText('供应商名称')).toBeVisible();
    await expect(page.getByText('API 类型')).toBeVisible();
    await expect(page.getByText('接口地址')).toBeVisible();
    await expect(page.getByText('凭据类型')).toBeVisible();
    await expect(page.getByText('凭据值')).toBeVisible();
  });

  test('should show model section with custom model button and empty state', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    const section = page.locator('#model-section');
    await expect(section.getByRole('heading', { name: '可用模型' })).toBeVisible();
    await expect(section.getByRole('button', { name: '自定义模型' })).toBeVisible();
    await expect(section.getByText(/暂无可用模型/)).toBeVisible();
  });

  test('should open custom model dialog on button click', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.locator('#model-section').getByRole('button', { name: '自定义模型' }).click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: '自定义模型' })).toBeVisible();
    await expect(page.getByText('请先添加供应商')).toBeVisible();
  });

  test('should show validation on empty provider form', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.locator('#provider-section').getByRole('button', { name: '添加供应商' }).click();

    const saveBtn = page.getByRole('button', { name: '保存' });
    await expect(saveBtn).toBeDisabled();
  });

  test('should close add provider dialog on cancel', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.locator('#provider-section').getByRole('button', { name: '添加供应商' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('should close custom model dialog on cancel', async ({ page }) => {
    const username = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });

    await page.locator('#model-section').getByText('自定义模型').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });
});
