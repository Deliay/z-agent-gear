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
  const username = `eh${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
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
  `, { input: { name: `e2e-hs-key-${Date.now()}`, type: 'local' } }, token);
  const body = await res.json();
  return { rawKey: body.data.createControllerKey.rawKey };
}

function registerController(rawKey: string): Promise<{ controllerId: string; disconnect: () => void }> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'], reconnection: false, forceNew: true,
    });
    const timer = setTimeout(() => { client.disconnect(); reject(new Error('Timeout registering controller')); }, 10000);

    client.on('acp:check', (data: { requestId: string }) => {
      client.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      });
    });

    client.on('acp:list-sessions', (data: { requestId: string; cwd: string }) => {
      client.emit('acp:list-sessions:result', {
        requestId: data.requestId,
        success: true,
        sessions: [
          { sessionId: 'e2e_sess_1', title: 'E2E Test Session 1', cwd: data.cwd, updatedAt: new Date().toISOString() },
          { sessionId: 'e2e_sess_2', title: null, cwd: data.cwd, updatedAt: null },
        ],
      });
    });

    client.on('acp:load-session', (data: { requestId: string; sessionId: string; cwd: string }) => {
      client.emit('acp:load-session:result', {
        requestId: data.requestId,
        success: true,
        sessionId: data.sessionId,
        title: `History - ${data.sessionId}`,
        messages: [
          { direction: 'input', type: 'text', content: JSON.stringify({ text: 'Hello from history' }) },
          { direction: 'output', type: 'text', content: JSON.stringify({ text: 'Hi back' }) },
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
    client.emit('register', { key: rawKey, hostname: `e2e-hs-host-${Date.now()}`, version: '1.0.0' });
  });
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
}

async function createWorkspace(page: import('@playwright/test').Page, controllerId: string, path: string, token: string) {
  const res = await gqlRequest(page, `
    mutation CreateWorkspace($input: CreateWorkspaceInput!) {
      createWorkspace(input: $input) { id name path }
    }
  `, { input: { controllerId, path } }, token);
  const body = await res.json();
  return body.data.createWorkspace;
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
          { type: 'claude_code', available: true, version: '1.0.0' },
          { type: 'gemini_cli', available: true, version: '1.0.0' },
          { type: 'codex', available: true, version: '1.0.0' },
        ],
      });
    });

    client.on('acp:list-sessions', (data: { requestId: string; cwd: string }) => {
      client.emit('acp:list-sessions:result', {
        requestId: data.requestId,
        success: true,
        sessions: [
          { sessionId: 'e2e_sess_1', title: 'E2E Test Session 1', cwd: data.cwd, updatedAt: new Date().toISOString() },
          { sessionId: 'e2e_sess_2', title: null, cwd: data.cwd, updatedAt: null },
        ],
      });
    });

    client.on('acp:load-session', (data: { requestId: string; sessionId: string; cwd: string }) => {
      client.emit('acp:load-session:result', {
        requestId: data.requestId,
        success: true,
        sessionId: data.sessionId,
        title: `History - ${data.sessionId}`,
        messages: [
          { direction: 'input', type: 'text', content: JSON.stringify({ text: 'Hello from history' }) },
          { direction: 'output', type: 'text', content: JSON.stringify({ text: 'Hi back' }) },
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
    client.emit('register', { key: rawKey, hostname: `e2e-hs-multi-acp-host-${Date.now()}`, version: '1.0.0' });
  });
}

async function goToConfigPage(page: import('@playwright/test').Page) {
  await page.locator('#controller-section').getByRole('button', { name: '配置' }).first().click();
  await expect(page).toHaveURL(/settings\?controllerId=/);
}

test.describe('Settings History Session E2E', () => {

  test('should show history session button for enabled workspace with online controller', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    await createWorkspace(page, controllerId, '/home/user/project', token);

    await loginViaUI(page, username);
    await page.goto('/settings');
    await goToConfigPage(page);

    const wsButton = page.getByRole('button', { name: '历史会话' });
    await expect(wsButton).toBeVisible({ timeout: 5000 });
    await expect(wsButton).not.toBeDisabled();

    disconnect();
  });

  test('should list history sessions from controller and show import button', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, '/home/user/project', token);

    await loginViaUI(page, username);
    await page.goto('/settings');
    await goToConfigPage(page);

    await page.getByRole('button', { name: '历史会话' }).click();

    await expect(page.getByRole('heading', { name: /历史会话/ })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('E2E Test Session 1')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('2 个可导入的会话')).toBeVisible();
    await expect(page.getByRole('button', { name: /导入已选/ })).toBeVisible();

    disconnect();
  });

  test('should select all sessions and import successfully', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, '/home/user/project', token);

    await loginViaUI(page, username);
    await page.goto('/settings');
    await goToConfigPage(page);

    await page.getByRole('button', { name: '历史会话' }).click();
    await expect(page.getByText('2 个可导入的会话')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: '全选' }).click();
    await expect(page.getByRole('button', { name: '导入已选 (2)' })).toBeVisible();

    await page.getByRole('button', { name: '导入已选 (2)' }).click();

    await expect(page.getByText('成功导入 2 个会话')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('已导入 2/2')).toBeVisible();

    await page.getByRole('button', { name: '完成' }).click();
    await expect(page.getByRole('heading', { name: /历史会话/ })).not.toBeVisible();

    disconnect();
  });

  test('should show ACP Server selector in history session dialog when multiple servers available', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerControllerWithMultiAcp(rawKey);
    await createWorkspace(page, controllerId, '/home/user/project', token);

    await loginViaUI(page, username);
    await page.goto('/settings');
    await goToConfigPage(page);

    await page.getByRole('button', { name: '历史会话' }).click();
    await expect(page.getByRole('heading', { name: /历史会话/ })).toBeVisible({ timeout: 15000 });

    await expect(page.getByText('ACP Server:')).toBeVisible({ timeout: 10000 });
    const acpSelect = page.locator('select').first();
    await expect(acpSelect).toBeVisible();
    await expect(acpSelect).toHaveValue('opencode');

    disconnect();
  });

  test('should show empty state when no history sessions available', async ({ page }) => {
    const { token, username } = await registerUser(page);

    const emptyKeyRes = await gqlRequest(page, `
      mutation CreateKey($input: CreateKeyInput!) {
        createControllerKey(input: $input) { rawKey key { id } }
      }
    `, { input: { name: `e2e-empty-key-${Date.now()}`, type: 'local' } }, token);
    const emptyKeyBody = await emptyKeyRes.json();
    const emptyRawKey = emptyKeyBody.data.createControllerKey.rawKey;

    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'], reconnection: false, forceNew: true,
    });
    const controllerId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { client.disconnect(); reject(new Error('Timeout')); }, 10000);
      client.on('acp:list-sessions', (data: { requestId: string }) => {
        client.emit('acp:list-sessions:result', { requestId: data.requestId, success: true, sessions: [] });
      });
      client.once('registered', (data: { controllerId: string }) => { clearTimeout(timer); resolve(data.controllerId); });
      client.once('error', (data) => { clearTimeout(timer); client.disconnect(); reject(new Error(data.message)); });
      client.emit('register', { key: emptyRawKey, hostname: `e2e-empty-host-${Date.now()}`, version: '1.0.0' });
    });
    const ws2 = await createWorkspace(page, controllerId, '/home/user/empty', token);

    await loginViaUI(page, username);
    await page.goto('/settings');
    await goToConfigPage(page);

    await page.getByRole('button', { name: '历史会话' }).click();

    await expect(page.getByText('该工作目录下没有未导入的历史会话')).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: '关闭' })).toBeVisible();

    client.disconnect();
  });
});
