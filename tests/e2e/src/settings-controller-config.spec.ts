import { test, expect } from '@playwright/test';
import { io as SocketIOClient } from 'socket.io-client';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return page.request.post(API_URL, { headers, data: { query, variables } });
}

async function registerUser(page: import('@playwright/test').Page): Promise<{ token: string; username: string }> {
  const username = `cfg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
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
  `, { input: { name: `e2e-cfg-key-${Date.now()}`, type: 'local' } }, token);
  const body = await res.json();
  return { rawKey: body.data.createControllerKey.rawKey };
}

function registerController(rawKey: string): Promise<{ controllerId: string; disconnect: () => void }> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'], reconnection: false, forceNew: true,
    });
    const timer = setTimeout(() => { client.disconnect(); reject(new Error('Timeout registering controller')); }, 10000);

    client.on("git:worktree:list", (data: { requestId: string }) => {
      client.emit("git:worktree:list:result", { requestId: data.requestId, success: true, worktrees: [] });
    });

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
      reject(new Error(`Register failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname: `e2e-cfg-host-${Date.now()}`, version: '2.0.0' });
  });
}

function registerControllerWithMultiAcp(rawKey: string): Promise<{ controllerId: string; disconnect: () => void }> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'], reconnection: false, forceNew: true,
    });
    const timer = setTimeout(() => { client.disconnect(); reject(new Error('Timeout')); }, 10000);

    client.on("git:worktree:list", (data: { requestId: string }) => {
      client.emit("git:worktree:list:result", { requestId: data.requestId, success: true, worktrees: [] });
    });

    client.on('acp:check', (data: { requestId: string }) => {
      client.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [
          { type: 'opencode', available: true, version: '1.0.0' },
          { type: 'github_copilot', available: true, version: '1.0.0' },
        ],
      });
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
    client.emit('register', { key: rawKey, hostname: `e2e-cfg-multi-host-${Date.now()}`, version: '2.0.0' });
  });
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
}

test.describe('Settings Controller Config Page E2E', () => {

  test('should navigate to config page via sidebar gear icon', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    const sidebar = page.locator('nav[aria-label="Sidebar"]');

    const gearIcon = sidebar.locator('[role="button"][title="控制器配置"]');
    await expect(gearIcon).toBeVisible({ timeout: 5000 });
    await gearIcon.click();

    await expect(page).toHaveURL(/settings\?controllerId=/);
    await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible({ timeout: 5000 });

    disconnect();
  });

  test('should navigate to config page via settings 配置 button', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });

    await page.locator('#controller-section').getByRole('button', { name: '配置' }).first().click();
    await expect(page).toHaveURL(/settings\?controllerId=/);

    disconnect();
  });

  test('should show config page layout with back button and controller name', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });

    await page.locator('#controller-section').getByRole('button', { name: '配置' }).first().click();

    await expect(page.getByText('← 返回')).toBeVisible();
    await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible();
    await expect(page.getByText('可用 Harness 工具')).toBeVisible();
    await expect(page.getByRole('main').getByText(/e2e-cfg-host/)).toBeVisible();
    // 普通主机不展示云电脑停止/删除入口
    await expect(page.getByTestId('cloud-host-panel')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '停止云电脑' })).toHaveCount(0);

    disconnect();
  });

  test('should switch between workspace and harness tools sections', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });

    await page.locator('#controller-section').getByRole('button', { name: '配置' }).first().click();
    await expect(page.getByText('暂无工作区，点击「添加」开始配置')).toBeVisible();

    await page.getByRole('button', { name: '可用 Harness 工具' }).click();
    await expect(page.getByRole('heading', { name: '可用 Harness 工具' })).toBeVisible();
    await expect(page.getByRole('button', { name: '刷新' })).toBeVisible();

    await page.getByRole('button', { name: '工作区' }).click();
    await expect(page.getByText('暂无工作区，点击「添加」开始配置')).toBeVisible();

    disconnect();
  });

  test('should show harness tools section with capabilities from controller', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });

    await page.locator('#controller-section').getByRole('button', { name: '配置' }).first().click();
    await page.getByRole('button', { name: '可用 Harness 工具' }).click();

    await expect(page.getByText('opencode')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('可用', { exact: true })).toBeVisible();
    await expect(page.getByText('v1.0.0')).toBeVisible();

    disconnect();
  });

  test('should show multiple ACP server types in harness tools section', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { disconnect } = await registerControllerWithMultiAcp(rawKey);

    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });

    await page.locator('#controller-section').getByRole('button', { name: '配置' }).first().click();
    await page.getByRole('button', { name: '可用 Harness 工具' }).click();

    await expect(page.getByText('opencode')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('github_copilot')).toBeVisible();
    await expect(page.getByText('可用', { exact: true })).toHaveCount(2);

    disconnect();
  });

  test('should show refresh button on harness tools section', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });

    await page.locator('#controller-section').getByRole('button', { name: '配置' }).first().click();
    await page.getByText('可用 Harness 工具').click();

    const refreshBtn = page.getByRole('button', { name: '刷新' });
    await expect(refreshBtn).toBeVisible({ timeout: 15000 });

    await refreshBtn.click();
    await expect(refreshBtn).not.toBeDisabled({ timeout: 10000 });

    disconnect();
  });

  test('should navigate back to settings from config page', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });

    await page.locator('#controller-section').getByRole('button', { name: '配置' }).first().click();
    await expect(page).toHaveURL(/settings\?controllerId=/);

    await page.getByText('← 返回').click();
    await expect(page).toHaveURL('/settings');
    await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });

    disconnect();
  });

  test('should show sidebar gear icon that does not trigger expand', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    const sidebar = page.locator('nav[aria-label="Sidebar"]');

    const controllerBtn = sidebar.getByText(/e2e-cfg-host/).first();
    await expect(controllerBtn).toBeVisible({ timeout: 5000 });

    const gearIcon = sidebar.locator('[role="button"][title="控制器配置"]');
    await gearIcon.click();

    await expect(page).toHaveURL(/settings\?controllerId=/);

    disconnect();
  });

});
