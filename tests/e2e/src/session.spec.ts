import { test, expect } from '@playwright/test';
import { io as SocketIOClient } from 'socket.io-client';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const body: Record<string, unknown> = { query };
  if (variables) {
    body.variables = variables;
  }
  return page.request.post(API_URL, { headers, data: body });
}

async function registerUser(page: import('@playwright/test').Page): Promise<{ token: string; username: string }> {
  const username = `e2e_sess_${Date.now().toString(36)}`;
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

async function createControllerKey(page: import('@playwright/test').Page, token: string): Promise<{ rawKey: string; keyId: string }> {
  const res = await gqlRequest(page, `
    mutation CreateKey($input: CreateKeyInput!) {
      createControllerKey(input: $input) {
        key { id name }
        rawKey
      }
    }
  `, { input: { name: `e2e-key-${Date.now()}`, type: 'local' } }, token);
  const body = await res.json();
  return { rawKey: body.data.createControllerKey.rawKey, keyId: body.data.createControllerKey.key.id };
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

function registerController(rawKey: string): Promise<{ controllerId: string; disconnect: () => void }> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });

    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error('Timeout registering controller'));
    }, 10000);

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

    client.emit('register', { key: rawKey, hostname: 'e2e-test-host', version: '1.0.0' });
  });
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
}

const sidebar = () => 'nav[aria-label="Sidebar"]';

test.describe('Session E2E', () => {

  test('should show session list page with empty state', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);

    await page.goto('/sessions');
    await expect(page.locator('h1')).toContainText('会话');
    await expect(page.getByText('No sessions found.')).toBeVisible();
    await expect(page.getByRole('button', { name: '新建会话' })).toBeVisible();
  });

  test('should show no online controllers in New Session dialog', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);

    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '新建会话' }).click();
    await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();
    await expect(page.getByText('No online controllers available')).toBeVisible();
    await expect(page.getByRole('button', { name: '创建会话' })).toBeDisabled();

    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByText('No online controllers available')).not.toBeVisible();
  });

  test('should show online controller in New Session dialog', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-session-${Math.random().toString(36).slice(2, 8)}`, token);
    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '新建会话' }).click();
    await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();

    const select = page.locator('#controller');
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveCount(2); // placeholder + 1 controller
    await expect(select.locator('option').nth(1)).toContainText('e2e-test-host');

    await page.getByRole('button', { name: '取消' }).click();
    disconnect();
  });

  test('should create session and navigate to session detail', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-session-${Math.random().toString(36).slice(2, 8)}`, token);
    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '新建会话' }).click();
    await page.locator('#controller').selectOption({ index: 1 });
    await expect(page.getByRole('button', { name: '创建会话' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: '创建会话' }).click();

    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 10000 });
    disconnect();
  });

  test('should show session detail page structure', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-session-${Math.random().toString(36).slice(2, 8)}`, token);
    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '新建会话' }).click();
    await page.locator('#controller').selectOption({ index: 1 });
    await expect(page.getByRole('button', { name: '创建会话' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: '创建会话' }).click();
    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 10000 });

    await expect(page.getByText('e2e-test-host').first()).toBeVisible();
    await expect(page.locator('textarea')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(page.getByRole('button', { name: '关闭' })).toBeVisible();
    await expect(page.getByRole('button', { name: '删除' })).toBeVisible();

    disconnect();
  });

  test('should disable input when session is not running', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-session-${Math.random().toString(36).slice(2, 8)}`, token);
    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '新建会话' }).click();
    await page.locator('#controller').selectOption({ index: 1 });
    await expect(page.getByRole('button', { name: '创建会话' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: '创建会话' }).click();
    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 10000 });

    const textarea = page.locator('textarea');
    // Session may have already transitioned to 'idling' via SSE, in which case input is enabled
    const statusBadge = page.locator('.px-2.py-1.text-xs.font-medium.rounded-full');
    const statusText = await statusBadge.textContent();
    if (statusText !== '空闲' && statusText !== '工作中') {
      await expect(textarea).toBeDisabled();
      await expect(textarea).toHaveAttribute('placeholder', 'Session is not active...');
    }

    disconnect();
  });

  test('should show session status badge', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-session-${Math.random().toString(36).slice(2, 8)}`, token);
    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '新建会话' }).click();
    await page.locator('#controller').selectOption({ index: 1 });
    await expect(page.getByRole('button', { name: '创建会话' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: '创建会话' }).click();
    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 10000 });

    const statusBadge = page.locator('.px-2.py-1.text-xs.font-medium.rounded-full');
    await expect(statusBadge).toBeVisible();
    const statusText = await statusBadge.textContent();
    expect(['创建中', '连接中', '工作中', '空闲']).toContain(statusText);

    disconnect();
  });

  test('should close session and update status', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-session-${Math.random().toString(36).slice(2, 8)}`, token);
    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '新建会话' }).click();
    await page.locator('#controller').selectOption({ index: 1 });
    await expect(page.getByRole('button', { name: '创建会话' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: '创建会话' }).click();
    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 10000 });

    await page.getByRole('button', { name: '关闭' }).click();
    await expect(page.locator('.px-2.py-1.text-xs.font-medium.rounded-full')).toContainText('已结束', { timeout: 5000 });
    await expect(page.locator('textarea')).toBeDisabled();
    await expect(page.getByRole('button', { name: '关闭' })).not.toBeVisible();

    disconnect();
  });

  test('should delete session and navigate back', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-session-${Math.random().toString(36).slice(2, 8)}`, token);
    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '新建会话' }).click();
    await page.locator('#controller').selectOption({ index: 1 });
    await expect(page.getByRole('button', { name: '创建会话' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: '创建会话' }).click();
    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 10000 });

    // Expand sidebar tree to verify session appears
    const sidebar = page.locator('nav[aria-label="Sidebar"]');
    await sidebar.getByRole('button', { name: /e2e-test-host/ }).click();
    await sidebar.getByRole('button', { name: /📁/ }).click();
    await expect(sidebar.locator('a[href^="/sessions/"]')).toBeVisible({ timeout: 5000 });

    page.on('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '删除' }).click();
    await expect(page).toHaveURL('/sessions', { timeout: 5000 });
    await expect(page.getByText('No sessions found.')).toBeVisible();

    // Sidebar should no longer show the deleted session
    await expect(sidebar.locator('a[href^="/sessions/"]')).not.toBeVisible();

    disconnect();
  });

  test('should redirect unauthenticated user to login', async ({ page }) => {
    await page.goto('/sessions');
    await expect(page.locator('[data-slot="card-title"]')).toContainText('登录', { timeout: 5000 });
  });
});
