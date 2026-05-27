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
  const username = `e2e_pf_${Date.now().toString(36)}`;
  const res = await gqlRequest(page, `
    mutation Signup($username: String!, $password: String!) {
      signup(username: $username, password: $password) { token user { id username } }
    }
  `, { username, password: 'testpass123' });
  const body = await res.json();
  return { token: body.data.signup.token, username };
}

async function createControllerKey(page: import('@playwright/test').Page, token: string): Promise<{ rawKey: string }> {
  const res = await gqlRequest(page, `
    mutation CreateKey($input: CreateKeyInput!) {
      createControllerKey(input: $input) { rawKey key { id } }
    }
  `, { input: { name: `e2e-pf-${Date.now()}`, type: 'local' } }, token);
  const body = await res.json();
  return { rawKey: body.data.createControllerKey.rawKey };
}

function registerController(rawKey: string): Promise<{ controllerId: string; disconnect: () => void; socket: import('socket.io-client').Socket }> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, { transports: ['websocket'], reconnection: false, forceNew: true });
    const timer = setTimeout(() => { client.disconnect(); reject(new Error('Timeout')); }, 10000);

    client.on('acp:check', (data: { requestId: string }) => {
      client.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      });
    });

    client.on('port-forward:create', (data: { tunnelId: string; port: number }) => {
      client.emit('port-forward:created', { tunnelId: data.tunnelId, success: true });
    });

    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve({ controllerId: data.controllerId, disconnect: () => client.disconnect(), socket: client });
    });
    client.once('error', (data: { code: string; message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname: 'e2e-pf-host', version: '1.0.0' });
  });
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await page.locator('nav[aria-label="Sidebar"]').waitFor({ timeout: 10000 });
}

async function expandController(page: import('@playwright/test').Page) {
  const sidebar = page.locator('nav[aria-label="Sidebar"]');
  await sidebar.getByRole('button', { name: /e2e-pf-host/ }).click();
  return sidebar;
}

async function expandPortForward(page: import('@playwright/test').Page) {
  const sidebar = page.locator('nav[aria-label="Sidebar"]');
  await sidebar.getByText('端口转发').click();
  return sidebar;
}

test.describe('Port Forward E2E', () => {

  test('should show port forward section for online controller', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    const sidebar = await expandController(page);

    await expect(sidebar.getByText('端口转发')).toBeVisible({ timeout: 10000 });
    disconnect();
  });

  test('should show empty state when expanding port forwards', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await expandController(page);
    const sidebar = await expandPortForward(page);

    await expect(sidebar.getByText('无端口转发')).toBeVisible({ timeout: 10000 });
    disconnect();
  });

  test('should open port forward dialog', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await expandController(page);
    await expandPortForward(page);

    const sidebar = page.locator('nav[aria-label="Sidebar"]');
    await sidebar.getByRole('button', { name: '+', exact: true }).click();

    await expect(page.getByText('新建端口转发')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('input[type="number"]')).toBeVisible();
    await expect(page.getByText('取消')).toBeVisible();
    await expect(page.getByText('创建')).toBeVisible();

    await page.getByText('取消').click();
    await expect(page.getByText('新建端口转发')).not.toBeVisible();
    disconnect();
  });

  test('should create a port forward', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await expandController(page);
    await expandPortForward(page);

    const sidebar = page.locator('nav[aria-label="Sidebar"]');
    await sidebar.getByRole('button', { name: '+', exact: true }).click();

    await page.locator('input[type="number"]').fill('3000');
    await page.getByText('创建').click();

    await expect(page.getByText('新建端口转发')).not.toBeVisible({ timeout: 5000 });
    await expect(sidebar.getByText(':3000')).toBeVisible({ timeout: 15000 });
    await expect(sidebar.getByText('active')).toBeVisible({ timeout: 5000 });

    disconnect();
  });

  test('should show error for duplicate port', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await expandController(page);
    await expandPortForward(page);

    const sidebar = page.locator('nav[aria-label="Sidebar"]');

    // Create first port forward
    await sidebar.getByRole('button', { name: '+', exact: true }).click();
    await page.locator('input[type="number"]').fill('3001');
    await page.getByText('创建').click();
    await expect(page.getByText('新建端口转发')).not.toBeVisible({ timeout: 5000 });
    await expect(sidebar.getByText(':3001')).toBeVisible({ timeout: 15000 });

    // Try to create duplicate
    await sidebar.getByRole('button', { name: '+', exact: true }).click();
    await page.locator('input[type="number"]').fill('3001');
    await page.getByText('创建').click();

    await expect(page.locator('p.text-red-400')).toBeVisible({ timeout: 10000 });

    await page.getByText('取消').click();
    disconnect();
  });

  test('should delete a port forward', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await expandController(page);
    await expandPortForward(page);

    const sidebar = page.locator('nav[aria-label="Sidebar"]');

    // Create port forward
    await sidebar.getByRole('button', { name: '+', exact: true }).click();
    await page.locator('input[type="number"]').fill('4000');
    await page.getByText('创建').click();
    await expect(sidebar.getByText(':4000')).toBeVisible({ timeout: 15000 });

    // Delete it
    await sidebar.getByTitle('删除端口转发').click();
    await expect(sidebar.getByText(':4000')).not.toBeVisible({ timeout: 15000 });
    await expect(sidebar.getByText('无端口转发')).toBeVisible({ timeout: 5000 });

    disconnect();
  });

  test('should close dialog on cancel', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await expandController(page);
    await expandPortForward(page);

    const sidebar = page.locator('nav[aria-label="Sidebar"]');
    await sidebar.getByRole('button', { name: '+', exact: true }).click();

    await expect(page.getByText('新建端口转发')).toBeVisible({ timeout: 5000 });
    await page.getByText('取消').click();
    await expect(page.getByText('新建端口转发')).not.toBeVisible();

    disconnect();
  });

  test('should not show port forward section for offline controller', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    // Disconnect controller before login
    disconnect();

    await loginViaUI(page, username);

    // Wait for controller to show as offline (poll interval is 15s, but status may update sooner via SSE)
    await page.waitForTimeout(2000);

    const sidebar = page.locator('nav[aria-label="Sidebar"]');
    await sidebar.getByRole('button', { name: /e2e-pf-host/ }).click();

    // Port forward section should NOT be visible
    await expect(sidebar.getByText('端口转发')).not.toBeVisible({ timeout: 5000 });
  });

});
