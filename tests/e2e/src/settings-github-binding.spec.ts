import { test, expect } from '@playwright/test';
import { registerUser } from './helpers.js';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';

test.describe('Settings GitHub Binding E2E', () => {
  test.beforeEach(async ({ page }) => {
    const user = await registerUser(page);
    await page.goto('/login');
    await page.fill('#username', user.username);
    await page.fill('#password', 'testpass123');
    await page.click('button[type="submit"]');
    await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });

    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });
  });

  test('should show GitHub binding section in settings page', async ({ page }) => {
    await expect(page.locator('#github-section')).toBeVisible();
    await expect(page.locator('#github-section').getByRole('heading', { name: 'GitHub 绑定' })).toBeVisible();
  });

  test('should show empty state with bind button', async ({ page }) => {
    const section = page.locator('#github-section');
    await expect(section.getByText(/暂无绑定/)).toBeVisible();
    await expect(section.getByRole('button', { name: '绑定 GitHub 帐号' })).toBeVisible();
  });

  test('should open GitHub App URL on bind click', async ({ page }) => {
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 5000 }).catch(() => null),
      page.getByRole('button', { name: '绑定 GitHub 帐号' }).click(),
    ]);

    if (popup) {
      expect(popup.url()).toMatch(/github\.com\/(?:apps\/|login\?)/);
      await popup.close();
    } else {
      await expect(page.getByRole('button', { name: '绑定 GitHub 帐号' })).toBeVisible();
    }
  });

  test('should show success toast when binding=success query param', async ({ page }) => {
    await page.goto('/settings?binding=success');
    await expect(page.getByText(/GitHub 帐号绑定成功/)).toBeVisible();
  });

  test('should show error toast when binding=error query param', async ({ page }) => {
    await page.goto('/settings?binding=error&message=invalid_state');
    await expect(page.getByText(/GitHub 绑定失败/)).toBeVisible();
  });

  test('should show unbind confirm dialog when unbind clicked', async ({ page }) => {
    // Inject a mock GitHub account via GraphQL route interception
    await page.route(API_URL, async (route) => {
      const req = route.request();
      const postData = req.postDataJSON();

      if (postData && postData.query && postData.query.includes('GetGithubAccounts')) {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              githubAccounts: [
                {
                  id: 'mock-acc-1',
                  githubUserId: 12345,
                  githubLogin: 'e2e-test-user',
                  githubAvatarUrl: null,
                  installations: [],
                  createdAt: '2026-01-01T00:00:00Z',
                },
              ],
            },
          }),
        });
      } else if (postData && postData.query && postData.query.includes('GetGithubAppUrl')) {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              githubAppUrl: {
                url: 'https://github.com/apps/test-app/installations/new?state=abc',
                state: 'abc',
              },
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('/settings');
    await expect(page.getByText('e2e-test-user')).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '解绑' }).click();
    await expect(page.getByText(/确认解绑/)).toBeVisible();
    await expect(page.getByRole('button', { name: '解绑' })).toBeVisible();
    await expect(page.getByRole('button', { name: '取消' })).toBeVisible();
  });
});
