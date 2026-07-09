import { test, expect } from '@playwright/test';
import { registerUser } from './helpers.js';

const TEST_USER = `gh_${Date.now()}`;
const TEST_PASS = 'testpass123';

test.describe('Settings GitHub Binding E2E', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/register');
    await page.fill('#username', TEST_USER);
    await page.fill('#password', TEST_PASS);
    await page.click('button[type="submit"]');
    await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', TEST_USER);
    await page.fill('#password', TEST_PASS);
    await page.click('button[type="submit"]');
    await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });

    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });
  });

  test('should show GitHub binding section in settings page', async ({ page }) => {
    await expect(page.locator('#github-section')).toBeVisible();
    await expect(page.locator('#github-section').getByText('GitHub 绑定')).toBeVisible();
  });

  test('should show empty state with bind button', async ({ page }) => {
    const section = page.locator('#github-section');
    await expect(section.getByText(/暂无绑定/)).toBeVisible();
    await expect(section.getByRole('button', { name: '绑定 GitHub 帐号' })).toBeVisible();
  });

  test('should show success toast when binding=success query param', async ({ page }) => {
    await page.goto('/settings?binding=success');
    await expect(page.getByText(/GitHub 帐号绑定成功/)).toBeVisible();
  });

  test('should show error toast when binding=error query param', async ({ page }) => {
    await page.goto('/settings?binding=error&message=invalid_state');
    await expect(page.getByText(/GitHub 绑定失败/)).toBeVisible();
  });
});
