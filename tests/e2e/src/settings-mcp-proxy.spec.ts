import { test, expect } from '@playwright/test';
import { registerUser, loginViaUI, gqlRequest } from './helpers.js';

const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

test.describe('Settings MCP Proxy Key E2E', () => {
  test('should show MCP section in settings', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await expect(page.getByRole('heading', { name: 'MCP 代理' })).toBeVisible({ timeout: 10000 });
  });

  test('should show MCP Proxy Key section', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await expect(page.getByText('MCP Proxy Keys', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Generate Key').first()).toBeVisible();
  });

  test('should show MCP Server section', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await expect(page.getByText('MCP Servers', { exact: true })).toBeVisible({ timeout: 10000 });
  });

  test('should show empty state for MCP Proxy Keys', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await expect(page.getByText(/No MCP proxy keys yet/)).toBeVisible({ timeout: 10000 });
  });

  test('should show empty state for MCP Servers', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await expect(page.getByText(/No MCP servers registered yet/)).toBeVisible({ timeout: 10000 });
  });

  test('should open generate key dialog', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await page.getByText('Generate Key').first().click();
    await expect(page.getByText('Generate MCP Proxy Key')).toBeVisible({ timeout: 5000 });
    await expect(page.getByPlaceholder('e.g., My Development Machine')).toBeVisible();
  });

  test('should create MCP proxy key', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await page.getByText('Generate Key').first().click();
    await page.getByPlaceholder('e.g., My Development Machine').fill('Test E2E Key');
    await page.getByRole('button', { name: 'Generate' }).click();

    await expect(page.getByText('Your new MCP proxy key:')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Copy & Close')).toBeVisible();
  });

  test('should copy key and close dialog', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await page.getByText('Generate Key').first().click();
    await page.getByPlaceholder('e.g., My Development Machine').fill('Copy Test Key');
    await page.getByRole('button', { name: 'Generate' }).click();

    await expect(page.getByText('Your new MCP proxy key:')).toBeVisible({ timeout: 10000 });
    await page.getByText('Copy & Close').click();

    await expect(page.getByText('Copy Test Key')).toBeVisible({ timeout: 5000 });
  });

  test('should show created key in list', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    await page.getByText('Generate Key').first().click();
    await page.getByPlaceholder('e.g., My Development Machine').fill('List Test Key');
    await page.getByRole('button', { name: 'Generate' }).click();
    await page.getByText('Copy & Close').click();

    await expect(page.getByText('List Test Key')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('active')).toBeVisible();
  });

  test('should revoke MCP proxy key', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    // Listen for console errors
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log('Browser error:', msg.text());
      }
    });

    // Listen for network requests
    page.on('requestfailed', request => {
      console.log('Request failed:', request.url(), request.failure()?.errorText);
    });

    await page.getByText('Generate Key').first().click();
    await page.getByPlaceholder('e.g., My Development Machine').fill('Revoke Test Key');
    await page.getByRole('button', { name: 'Generate' }).click();
    await page.getByText('Copy & Close').click();

    // Wait for dialog to close
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });

    await expect(page.getByText('Revoke Test Key')).toBeVisible({ timeout: 5000 });

    // Find the key item container
    const keyContainer = page.locator('.flex.items-center.justify-between.rounded-lg.border.p-4').filter({ hasText: 'Revoke Test Key' });
    
    // Click the button inside the container
    await keyContainer.locator('button').click();

    // Wait for the status to change
    await page.waitForTimeout(2000);

    // Check if the status changed to revoked
    const statusText = await keyContainer.textContent();
    console.log('Key container text:', statusText);
    expect(statusText).toContain('revoked');
  });

  test('should navigate to MCP section via nav', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');

    const nav = page.locator('nav[aria-label="Settings navigation"]');
    await nav.getByText('MCP 管理').click();

    await expect(page.locator('#mcp-section')).toBeVisible({ timeout: 5000 });
  });
});
