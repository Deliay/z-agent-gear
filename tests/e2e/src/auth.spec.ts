import { test, expect } from '@playwright/test';

const TEST_USER = `e2e_${Date.now()}`;
const TEST_PASS = 'testpass123';

const sidebar = () => 'nav[aria-label="Sidebar"]';
const cardTitle = () => '[data-slot="card-title"]';

test.describe('Auth E2E', () => {

  test('should register a new user and redirect to main page', async ({ page }) => {
    await page.goto('/register');
    await expect(page.locator(cardTitle())).toContainText('注册');

    await page.fill('#username', TEST_USER);
    await page.fill('#password', TEST_PASS);
    await page.click('button[type="submit"]');

    await expect(page.locator(sidebar())).toBeVisible({ timeout: 10000 });
  });

  test('should login with existing credentials and show main layout', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator(cardTitle())).toContainText('登录');

    await page.fill('#username', TEST_USER);
    await page.fill('#password', TEST_PASS);
    await page.click('button[type="submit"]');

    await expect(page.locator(sidebar())).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('会话')).toBeVisible();
  });

  test('should show username in sidebar after login', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', TEST_USER);
    await page.fill('#password', TEST_PASS);
    await page.click('button[type="submit"]');

    await expect(page.locator(sidebar()).getByText(TEST_USER)).toBeVisible({ timeout: 10000 });
  });

  test('should show error for wrong password', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', TEST_USER);
    await page.fill('#password', 'wrongpass');
    await page.click('button[type="submit"]');

    await expect(page.getByText('Invalid username or password')).toBeVisible({ timeout: 5000 });
  });

  test('should navigate to settings page via settings button', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', TEST_USER);
    await page.fill('#password', TEST_PASS);
    await page.click('button[type="submit"]');
    await expect(page.locator(sidebar())).toBeVisible({ timeout: 10000 });

    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });
  });

  test('should display settings page with 2-column layout', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', TEST_USER);
    await page.fill('#password', TEST_PASS);
    await page.click('button[type="submit"]');
    await expect(page.locator(sidebar())).toBeVisible({ timeout: 10000 });

    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('个人资料')).toBeVisible();
  });

  test('should logout and redirect to login page', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#username', TEST_USER);
    await page.fill('#password', TEST_PASS);
    await page.click('button[type="submit"]');
    await expect(page.locator(sidebar())).toBeVisible({ timeout: 10000 });

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
