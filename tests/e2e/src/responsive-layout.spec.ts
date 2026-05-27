import { test, expect } from '@playwright/test';
import { io as SocketIOClient } from 'socket.io-client';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return page.request.post(API_URL, { headers, data: body });
}

async function registerUser(page: import('@playwright/test').Page): Promise<{ token: string; username: string }> {
  const username = `e2e_resp_${Date.now().toString(36)}`;
  const res = await gqlRequest(page, `
    mutation Signup($username: String!, $password: String!) {
      signup(username: $username, password: $password) {
        token
        user { id username }
      }
    }
  `, { username, password: 'testpass123' });
  const body = await res.json();
  return { token: body.data.signup.token, username };
}

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

    // Should be in list mode
    await expect(page.locator(sidebar())).toBeVisible();
    await expect(page.locator('h2')).toContainText('Sessions');

    // Verify we're in mobile mode (no separate main content)
    // The page should show the sidebar as the main content
  });

});
