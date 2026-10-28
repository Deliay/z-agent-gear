import { test, expect } from '@playwright/test';
import { io as SocketIOClient } from 'socket.io-client';
import { registerUser } from './helpers';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

// iPhone 13 viewport
test.use({ viewport: { width: 375, height: 812 } });

async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return page.request.post(API_URL, { headers, data: body });
}

async function createControllerKey(page: import('@playwright/test').Page, token: string): Promise<{ rawKey: string; keyId: string }> {
  const res = await gqlRequest(page, `
    mutation CreateKey($input: CreateKeyInput!) {
      createControllerKey(input: $input) {
        key { id name }
        rawKey
      }
    }
  `, { input: { name: `e2e-mob-${Date.now()}`, type: 'local' } }, token);
  const body = await res.json();
  return { rawKey: body.data.createControllerKey.rawKey, keyId: body.data.createControllerKey.key.id };
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

function registerController(rawKey: string): Promise<{ controllerId: string; disconnect: () => void }> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    const timer = setTimeout(() => { client.disconnect(); reject(new Error('Timeout')); }, 10000);
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
    client.emit('register', { key: rawKey, hostname: 'e2e-mobile-host', version: '2.0.0' });
  });
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
}

async function createSession(page: import('@playwright/test').Page, controllerId: string, token: string, workspaceId?: string) {
  const res = await gqlRequest(page, `
    mutation CreateSession($input: CreateSessionInput!) {
      createSession(input: $input) { session { id } }
    }
  `, { input: { controllerId, acpServerType: 'opencode', ...(workspaceId ? { workspaceId } : {}) } }, token);
  const body = await res.json();
  return body.data.createSession.session.id;
}

const sidebar = () => 'nav[aria-label="Sidebar"]';

test.describe('Session Mobile Layout', () => {

  test('should show full-screen session list on mobile', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey, keyId } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-mob', token);

    try {
      await loginViaUI(page, username);
      await page.goto('/sessions');

      // Sidebar should be visible and take full width
      const sidebarEl = page.locator(sidebar());
      await expect(sidebarEl).toBeVisible();

      // 移动端会话列表由 Sidebar 承担（不再渲染旧的 h2「会话」标题）。
      await expect(page.locator(sidebar()).getByRole('button', { name: /^会话/ })).toBeVisible();

      // Controller should be visible in the tree
      await expect(page.getByText('e2e-mobile-host')).toBeVisible();
    } finally {
      disconnect();
    }
  });

  test('should navigate to session detail and show back button', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-mob', token);

    try {
      const sessionId = await createSession(page, controllerId, token, ws.id);
      await loginViaUI(page, username);

      // 控制器/工作区默认展开，直接点击会话链接（点击控制器会折叠）。
      await page.locator(sidebar()).locator('a[href^="/sessions/"]').first().click();

      // Should navigate to detail page - back button should be visible on mobile
      await expect(page.getByText('← 返回')).toBeVisible({ timeout: 10000 });

      // Status badge should be visible
      await expect(page.locator('.rounded-full.px-2')).toBeVisible();
    } finally {
      disconnect();
    }
  });

  test('should navigate back to list from session detail', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-mob', token);

    try {
      const sessionId = await createSession(page, controllerId, token, ws.id);
      await loginViaUI(page, username);

      // Navigate to session detail
      await page.goto(`/sessions/${sessionId}`);
      await expect(page.getByText('← 返回')).toBeVisible({ timeout: 10000 });

      // Click back button
      await page.getByText('← 返回').click();

      // Should be back on list - mobile Sidebar is visible again
      await expect(page.locator(sidebar())).toBeVisible({ timeout: 5000 });
    } finally {
      disconnect();
    }
  });

  test('should show settings with tab navigation on mobile', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);

    await page.goto('/settings');

    // Settings heading should be visible
    await expect(page.locator('h1')).toContainText('设置');

    // Tab buttons should be visible
    await expect(page.getByRole('button', { name: '帐号', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '供应商设置', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '可用模型', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '控制器管理', exact: true })).toBeVisible();

    // Back button should be visible
    await expect(page.getByText('← 返回')).toBeVisible();
  });

  test('should navigate back from settings to session list', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);

    await page.goto('/settings');
    await expect(page.locator('h1')).toContainText('设置');

    // Click back button
    const backButton = page.locator('button:has-text("← 返回")');
    await expect(backButton).toBeVisible({ timeout: 5000 });
    await backButton.click();

    // Wait for navigation
    await page.waitForURL('**/sessions', { timeout: 5000 });

    // Should be back on sessions list (mobile Sidebar visible)
    await expect(page.locator(sidebar())).toBeVisible({ timeout: 10000 });
  });

  test('should not show sidebar on session detail page', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, '/tmp/e2e-mob-sidebar', token);

    try {
      const sessionId = await createSession(page, controllerId, token, ws.id);
      await loginViaUI(page, username);

      await page.goto(`/sessions/${sessionId}`);

      // Sidebar should NOT be visible on detail page in mobile mode
      await expect(page.locator(sidebar())).not.toBeVisible({ timeout: 5000 });
    } finally {
      disconnect();
    }
  });

  test('should not show sidebar on settings page', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);

    await page.goto('/settings');

    // Sidebar should NOT be visible on settings page in mobile mode
    await expect(page.locator(sidebar())).not.toBeVisible({ timeout: 5000 });
  });

});
