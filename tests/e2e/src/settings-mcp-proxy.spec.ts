import { test, expect } from '@playwright/test';
import { registerUser, loginViaUI, gqlRequest } from './helpers.js';

const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

test.describe('Settings MCP Proxy Key E2E', () => {
  let token: string;
  let username: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const result = await registerUser(page);
    token = result.token;
    username = result.username;
    await page.close();
  });

  test('should show MCP section in settings', async ({ page }) => {
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await expect(page.getByText('MCP', { exact: true }).first()).toBeVisible({ timeout: 5000 });
  });

  test('should show MCP Proxy Key section', async ({ page }) => {
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await expect(page.getByText('MCP Proxy Keys')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Generate Key' })).toBeVisible();
  });

  test('should show MCP Server section', async ({ page }) => {
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await expect(page.getByText('MCP Servers')).toBeVisible({ timeout: 5000 });
  });

  test('should show empty state for MCP Proxy Keys', async ({ page }) => {
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await expect(page.getByText(/No MCP proxy keys yet/)).toBeVisible({ timeout: 5000 });
  });

  test('should show empty state for MCP Servers', async ({ page }) => {
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await expect(page.getByText(/No MCP servers registered yet/)).toBeVisible({ timeout: 5000 });
  });

  test('should open generate key dialog', async ({ page }) => {
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await page.getByRole('button', { name: 'Generate Key' }).click();
    await expect(page.getByText('Generate MCP Proxy Key')).toBeVisible({ timeout: 5000 });
    await expect(page.getByPlaceholder('e.g., My Development Machine')).toBeVisible();
  });

  test('should create MCP proxy key', async ({ page }) => {
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await page.getByRole('button', { name: 'Generate Key' }).click();
    await page.getByPlaceholder('e.g., My Development Machine').fill('Test E2E Key');
    await page.getByRole('button', { name: 'Generate' }).click();

    await expect(page.getByText(/mcp_/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Copy & Close')).toBeVisible();
  });

  test('should copy key and close dialog', async ({ page }) => {
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await page.getByRole('button', { name: 'Generate Key' }).click();
    await page.getByPlaceholder('e.g., My Development Machine').fill('Copy Test Key');
    await page.getByRole('button', { name: 'Generate' }).click();

    await expect(page.getByText(/mcp_/)).toBeVisible({ timeout: 5000 });
    await page.getByText('Copy & Close').click();

    await expect(page.getByText('Copy Test Key')).toBeVisible({ timeout: 5000 });
  });

  test('should show created key in list', async ({ page }) => {
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await page.getByRole('button', { name: 'Generate Key' }).click();
    await page.getByPlaceholder('e.g., My Development Machine').fill('List Test Key');
    await page.getByRole('button', { name: 'Generate' }).click();
    await page.getByText('Copy & Close').click();

    await expect(page.getByText('List Test Key')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('active')).toBeVisible();
  });

  test('should revoke MCP proxy key', async ({ page }) => {
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await page.getByRole('button', { name: 'Generate Key' }).click();
    await page.getByPlaceholder('e.g., My Development Machine').fill('Revoke Test Key');
    await page.getByRole('button', { name: 'Generate' }).click();
    await page.getByText('Copy & Close').click();

    await expect(page.getByText('Revoke Test Key')).toBeVisible({ timeout: 5000 });

    const keyItem = page.locator('div', { hasText: 'Revoke Test Key' }).first();
    await keyItem.locator('button').last().click();

    await expect(page.getByText('revoked')).toBeVisible({ timeout: 5000 });
  });

  test('should navigate to MCP section via nav', async ({ page }) => {
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    const nav = page.locator('nav[aria-label="Settings navigation"]');
    await nav.getByText('MCP 管理').click();

    await expect(page.locator('#mcp-section')).toBeVisible({ timeout: 5000 });
  });
});
