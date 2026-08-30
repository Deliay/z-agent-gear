import { test, expect } from '@playwright/test';
import { io as SocketIOClient } from 'socket.io-client';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

const sidebar = () => 'nav[aria-label="Sidebar"]';

async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>) {
  return page.request.post(API_URL, {
    headers: { 'Content-Type': 'application/json' },
    data: { query, variables },
  });
}

async function registerUser(page: import('@playwright/test').Page): Promise<{ token: string; username: string }> {
  const username = `ec${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
  const res = await gqlRequest(page, `
    mutation Signup($u: String!, $p: String!) {
      signup(username: $u, password: $p) { token user { id username } }
    }
  `, { u: username, p: 'testpass123' });
  const body = await res.json();
  if (!body.data?.signup) {
    throw new Error(`Signup failed: ${JSON.stringify(body)}`);
  }
  return { token: body.data.signup.token, username };
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await expect(page.locator(sidebar())).toBeVisible({ timeout: 10000 });
}

async function createControllerKey(page: import('@playwright/test').Page, token: string): Promise<{ keyId: string; rawKey: string }> {
  const res = await gqlRequest(page, `
    mutation CreateKey($input: CreateKeyInput!) {
      createControllerKey(input: $input) { key { id } rawKey }
    }
  `, { input: { name: `e2e-key-${Date.now()}`, type: 'local' } }, token);
  const body = await res.json();
  return { keyId: body.data.createControllerKey.key.id, rawKey: body.data.createControllerKey.rawKey };
}

function registerFakeController(rawKey: string): Promise<{ controllerId: string; disconnect: () => void }> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, { transports: ['websocket'], reconnection: false, forceNew: true });
    const timer = setTimeout(() => { client.disconnect(); reject(new Error('Timeout')); }, 10000);

    client.on('acp:check', (data: { requestId: string }) => {
      client.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      });
    });

    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve({ controllerId: data.controllerId, disconnect: () => client.disconnect() });
    });
    client.once('error', (data: { code: string; message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname: 'e2e-host', version: '2.0.0' });
  });
}

test.describe('Settings Controller E2E', () => {

  test('should register user and show controller section', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);

    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
  });

  test('should show controller management navigation', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const nav = page.locator('nav[aria-label="Settings navigation"]');

    await expect(nav.getByRole('button', { name: '控制器管理' })).toBeVisible();
  });

  test('should show controller section with Key and Controller cards', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const section = page.locator('#controller-section');

    await expect(section.getByRole('heading', { name: '控制器管理' })).toBeVisible();
    await expect(section.getByText('控制器', { exact: true })).toBeVisible();
  });

  test('should show key card with generate button and empty state', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const section = page.locator('#controller-section');

    await expect(section.getByRole('button', { name: '生成 Key' })).toBeVisible();
    await expect(section.getByText(/暂无控制器/)).toBeVisible();
  });

  test('should show controller card with empty state', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const section = page.locator('#controller-section');

    await expect(section.getByText(/暂无控制器/)).toBeVisible();
  });

  test('should generate key directly and show in key list', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const section = page.locator('#controller-section');

    await section.getByRole('button', { name: '生成 Key' }).click();
    await expect(section.getByText('等待连接').first()).toBeVisible({ timeout: 10000 });
    await expect(section.getByText('local').first()).toBeVisible();
  });

  test('should show revoke and rename buttons for generated keys', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const section = page.locator('#controller-section');

    await section.getByRole('button', { name: '生成 Key' }).click();
    await expect(section.getByText('等待连接').first()).toBeVisible({ timeout: 10000 });
    await expect(section.getByRole('button', { name: '复制' }).first()).toBeVisible();
  });

  test('should scroll to controller section from navigation', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });

    await page.locator('nav[aria-label="Settings navigation"]').getByRole('button', { name: '控制器管理' }).click();
    await expect(page.locator('#controller-section')).toBeVisible();
  });

  test('should show regenerate key button for bound controllers', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const section = page.locator('#controller-section');

    // Generate a key first
    await section.getByRole('button', { name: '生成 Key' }).click();
    await expect(section.getByText('等待连接').first()).toBeVisible({ timeout: 10000 });

    // The key should show "等待连接" status, not "重新生成Key" button
    // because it's not bound to a controller yet
    await expect(section.getByRole('button', { name: '重新生成Key' })).not.toBeVisible();
  });

  test('should regenerate key and show unbound controller', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const section = page.locator('#controller-section');

    // Create key and register controller
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerFakeController(rawKey);

    // Wait for controller to appear as online
    await expect(section.getByText('在线').first()).toBeVisible({ timeout: 10000 });

    // Click regenerate key button
    await section.getByRole('button', { name: '重新生成Key' }).first().click();

    // Confirm regeneration
    await expect(page.getByText('重新生成key后，旧key将立即失效')).toBeVisible();
    await page.getByRole('button', { name: '确认' }).click();

    // Verify new key dialog appears
    await expect(page.getByText('新Key已生成')).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: '关闭' }).click();

    // Verify controller shows as unbound
    await expect(section.getByText('未绑定').first()).toBeVisible({ timeout: 5000 });

    disconnect();
  });

  test('should allow rebind after regeneration and regenerate again', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
    const section = page.locator('#controller-section');

    // Step 1: Create key and register controller
    const { rawKey: firstRawKey } = await createControllerKey(page, token);
    const controller1 = await registerFakeController(firstRawKey);

    // Wait for controller to appear as online
    await expect(section.getByText('在线').first()).toBeVisible({ timeout: 10000 });

    // Step 2: Regenerate key
    await section.getByRole('button', { name: '重新生成Key' }).first().click();
    await page.getByRole('button', { name: '确认' }).click();
    await expect(page.getByText('新Key已生成')).toBeVisible({ timeout: 5000 });

    // Get the new key from the dialog
    const newKeyText = await page.locator('code').textContent();
    expect(newKeyText).toMatch(/^zag_k_/);

    await page.getByRole('button', { name: '关闭' }).click();

    // Step 3: Verify controller shows as unbound
    await expect(section.getByText('未绑定').first()).toBeVisible({ timeout: 5000 });

    // Step 4: Rebind with the new key
    const controller2 = await registerFakeController(newKeyText!);

    // Wait for controller to appear as online again
    await expect(section.getByText('在线').first()).toBeVisible({ timeout: 10000 });

    // Step 5: Regenerate key again
    await section.getByRole('button', { name: '重新生成Key' }).first().click();
    await page.getByRole('button', { name: '确认' }).click();
    await expect(page.getByText('新Key已生成')).toBeVisible({ timeout: 5000 });

    // Verify another new key is generated
    const secondNewKeyText = await page.locator('code').textContent();
    expect(secondNewKeyText).toMatch(/^zag_k_/);
    expect(secondNewKeyText).not.toBe(newKeyText);

    await page.getByRole('button', { name: '关闭' }).click();

    // Verify controller shows as unbound again
    await expect(section.getByText('未绑定').first()).toBeVisible({ timeout: 5000 });

    controller1.disconnect();
    controller2.disconnect();
  });
});
