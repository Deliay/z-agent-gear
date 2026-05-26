import { test, expect } from '@playwright/test';
import { io as SocketIOClient } from 'socket.io-client';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return page.request.post(API_URL, { headers, data: { query, variables } });
}

async function registerUser(page: import('@playwright/test').Page): Promise<{ token: string; username: string }> {
  const username = `acp_${Date.now().toString(36)}`;
  const res = await gqlRequest(page, `
    mutation Signup($u: String!, $p: String!) {
      signup(username: $u, password: $p) { token user { id username } }
    }
  `, { u: username, p: 'testpass123' });
  const body = await res.json();
  return { token: body.data.signup.token, username };
}

async function createControllerKey(page: import('@playwright/test').Page, token: string): Promise<{ rawKey: string }> {
  const res = await gqlRequest(page, `
    mutation CreateKey($input: CreateKeyInput!) {
      createControllerKey(input: $input) { rawKey key { id } }
    }
  `, { input: { name: `e2e-acp-key-${Date.now()}`, type: 'local' } }, token);
  const body = await res.json();
  return { rawKey: body.data.createControllerKey.rawKey };
}

function registerControllerWithMultiAcp(rawKey: string): Promise<{ controllerId: string; disconnect: () => void }> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'], reconnection: false, forceNew: true,
    });
    const timer = setTimeout(() => { client.disconnect(); reject(new Error('Timeout registering controller')); }, 10000);

    client.on('acp:check', (data: { requestId: string }) => {
      client.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [
          { type: 'opencode', available: true, version: '1.0.0' },
          { type: 'github_copilot', available: true, version: '1.0.0' },
        ],
      });
    });

    client.on('fs:mkdir', (data: { requestId: string }) => {
      client.emit('fs:mkdir:result', { requestId: data.requestId, success: true });
    });

    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve({ controllerId: data.controllerId, disconnect: () => client.disconnect() });
    });
    client.once('error', (data: { code: string; message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Register failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname: `e2e-acp-host-${Date.now()}`, version: '1.0.0' });
  });
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
}

async function createWorkspace(page: import('@playwright/test').Page, controllerId: string, path: string, token: string): Promise<{ id: string }> {
  const res = await gqlRequest(page, `
    mutation CreateWorkspace($input: CreateWorkspaceInput!) {
      createWorkspace(input: $input) { id name path }
    }
  `, { input: { controllerId, path } }, token);
  const body = await res.json();
  return body.data.createWorkspace;
}

test.describe('Session ACP Server Type', () => {

  test('should show ACP Server selector after selecting controller', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerControllerWithMultiAcp(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-acp-${Math.random().toString(36).slice(2, 8)}`, token);

    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: 'New Session' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'New Session' }).click();
    await expect(page.getByRole('heading', { name: 'New Session' })).toBeVisible();

    await page.locator('#controller').selectOption({ index: 1 });

    // ACP Server section should appear and loading should complete
    await expect(page.getByText('Detecting ACP servers...')).not.toBeVisible({ timeout: 10000 });
    const acpTrigger = page.locator('[role="combobox"]').first();
    await expect(acpTrigger).toBeVisible({ timeout: 10000 });

    // Click to open dropdown and verify both options
    await acpTrigger.click();
    await expect(page.getByRole('option', { name: /opencode/ })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('option', { name: /github_copilot/ })).toBeVisible();

    disconnect();
  });

  test('should create session with github_copilot and show badge', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerControllerWithMultiAcp(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-acp-gc-${Math.random().toString(36).slice(2, 8)}`, token);

    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: 'New Session' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'New Session' }).click();
    await expect(page.getByRole('heading', { name: 'New Session' })).toBeVisible();

    await page.locator('#controller').selectOption({ index: 1 });

    // Wait for ACP Server loading to complete
    await expect(page.getByText('Detecting ACP servers...')).not.toBeVisible({ timeout: 10000 });
    const acpTrigger = page.locator('[role="combobox"]').first();
    await expect(acpTrigger).toBeVisible({ timeout: 5000 });
    await acpTrigger.click();
    await page.getByRole('option', { name: /github_copilot/ }).click();
    await expect(acpTrigger).toContainText('github_copilot', { timeout: 5000 });

    // Create Session should now be enabled
    await expect(page.getByRole('button', { name: 'Create Session' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: 'Create Session' }).click();

    // Should navigate to session detail
    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 15000 });

    // Verify GitHub Copilot badge is visible
    await expect(page.getByText('GitHub Copilot')).toBeVisible({ timeout: 10000 });

    disconnect();
  });

  test('should create session with opencode and show OpenCode badge', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerControllerWithMultiAcp(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-acp-oc-${Math.random().toString(36).slice(2, 8)}`, token);

    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: 'New Session' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'New Session' }).click();
    await expect(page.getByRole('heading', { name: 'New Session' })).toBeVisible();

    await page.locator('#controller').selectOption({ index: 1 });

    // Wait for ACP Server loading to complete - opencode is auto-selected
    await expect(page.getByText('Detecting ACP servers...')).not.toBeVisible({ timeout: 10000 });

    // Create Session should be enabled with auto-selected opencode
    await expect(page.getByRole('button', { name: 'Create Session' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: 'Create Session' }).click();

    // Should navigate to session detail
    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 15000 });

    // Verify OpenCode badge is visible
    await expect(page.getByText('OpenCode')).toBeVisible({ timeout: 10000 });

    disconnect();
  });

});
