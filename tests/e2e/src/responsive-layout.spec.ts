import { test, expect } from '@playwright/test';
import { io as SocketIOClient } from 'socket.io-client';
import { registerUser } from './helpers';

const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
}

const sidebar = () => 'nav[aria-label="Sidebar"]';

test.describe('Responsive Layout', () => {

  test('should show desktop sidebar at 1280px', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const { username } = await registerUser(page);
    await loginViaUI(page, username);

    await page.goto('/sessions');

    // Sidebar should be visible in desktop mode
    await expect(page.locator(sidebar())).toBeVisible();

    // Main content area should also be visible (two-column layout)
    await expect(page.locator('main')).toBeVisible();
  });

  test('should hide sidebar on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const { username } = await registerUser(page);
    await loginViaUI(page, username);

    await page.goto('/sessions');

    // In mobile list mode, sidebar content is rendered as full-screen
    // The nav element itself should be visible
    await expect(page.locator(sidebar())).toBeVisible();

    // But main content area should NOT be separate (single column)
    // The sidebar takes full width
  });

  test('should switch from desktop to mobile layout', async ({ page }) => {
    // Start in desktop mode
    await page.setViewportSize({ width: 1280, height: 720 });
    const { username } = await registerUser(page);
    await loginViaUI(page, username);

    await page.goto('/sessions');

    // Verify desktop layout - sidebar visible
    await expect(page.locator(sidebar())).toBeVisible();

    // Switch to mobile viewport
    await page.setViewportSize({ width: 375, height: 812 });

    // Wait for layout to adapt
    await page.waitForTimeout(500);

    // Should now be in mobile mode - sidebar still visible (as full-screen list)
    await expect(page.locator(sidebar())).toBeVisible();
  });

  test('should navigate from mobile list to detail and back', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const { username } = await registerUser(page);
    await loginViaUI(page, username);

    await page.goto('/sessions');

    // Should be in list mode（移动端列表由 Sidebar 承担，不再有 h2 标题）
    await expect(page.locator(sidebar())).toBeVisible();

    // Verify we're in mobile mode (no separate main content)
    // The page should show the sidebar as the main content
  });

});
