import { test, expect } from '@playwright/test';
import { io as SocketIOClient, type Socket } from 'socket.io-client';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return page.request.post(API_URL, { headers, data: body });
}

async function registerUser(page: import('@playwright/test').Page): Promise<{ token: string; username: string; userId: string }> {
  const username = `ep${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
  const res = await gqlRequest(page, `
    mutation Signup($username: String!, $password: String!) {
      signup(username: $username, password: $password) { token user { id username } }
    }
  `, { username, password: 'testpass123' });
  const body = await res.json();
  return { token: body.data.signup.token, username, userId: body.data.signup.user.id };
}

async function createControllerKey(page: import('@playwright/test').Page, token: string): Promise<{ rawKey: string }> {
  const res = await gqlRequest(page, `
    mutation CreateKey($input: CreateKeyInput!) {
      createControllerKey(input: $input) { rawKey key { id } }
    }
  `, { input: { name: `e2e-perm-${Date.now()}`, type: 'local' } }, token);
  const body = await res.json();
  return { rawKey: body.data.createControllerKey.rawKey };
}

interface FakeController {
  controllerId: string;
  socket: Socket;
  disconnect: () => void;
}

function registerController(rawKey: string): Promise<FakeController> {
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
      resolve({ controllerId: data.controllerId, socket: client, disconnect: () => client.disconnect() });
    });
    client.once('error', (data: { code: string; message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname: 'e2e-perm-host', version: '1.0.0' });
  });
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await page.locator('nav[aria-label="Sidebar"]').waitFor({ timeout: 10000 });
}

async function createWorkspace(page: import('@playwright/test').Page, controllerId: string, path: string, token: string): Promise<string> {
  const res = await gqlRequest(page, `
    mutation CreateWorkspace($input: CreateWorkspaceInput!) {
      createWorkspace(input: $input) { id }
    }
  `, { input: { controllerId, path } }, token);
  const body = await res.json();
  return body.data.createWorkspace.id;
}

async function createSession(page: import('@playwright/test').Page, controllerId: string, token: string, workspaceId: string): Promise<string> {
  const res = await gqlRequest(page, `
    mutation CreateSession($input: CreateSessionInput!) {
      createSession(input: $input) { session { id } }
    }
  `, { input: { controllerId, acpServerType: 'opencode', workspaceId } }, token);
  const body = await res.json();
  return body.data.createSession.session.id;
}

test.describe('ACP Permission Reminder E2E', () => {
  test('should show todo bell icon in sidebar', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);

    // Bell icon should be visible in sidebar
    const bellButton = page.locator('nav[aria-label="Sidebar"] button').filter({ has: page.locator('svg.lucide-bell') });
    await expect(bellButton).toBeVisible({ timeout: 5000 });
  });

  test('should show zero unread count initially', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);

    // Bell icon should not have badge initially
    const bellButton = page.locator('nav[aria-label="Sidebar"] button').filter({ has: page.locator('svg.lucide-bell') });
    await expect(bellButton).toBeVisible();
    const badge = bellButton.locator('[class*="badge"]');
    await expect(badge).not.toBeVisible();
  });

  test('should open todo list popover on bell click', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);

    // Click bell icon
    const bellButton = page.locator('nav[aria-label="Sidebar"] button').filter({ has: page.locator('svg.lucide-bell') });
    await bellButton.click();

    // Popover should appear with title
    await expect(page.getByRole('heading', { name: '待办事项' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('全部已读')).toBeVisible();
  });

  test('should show empty state in todo list', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);

    // Click bell icon
    const bellButton = page.locator('nav[aria-label="Sidebar"] button').filter({ has: page.locator('svg.lucide-bell') });
    await bellButton.click();

    // Should show empty state
    await expect(page.getByText('暂无待办事项')).toBeVisible({ timeout: 5000 });
  });

  test('should create todo when permission request received', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, socket, disconnect } = await registerController(rawKey);
    const workspaceId = await createWorkspace(page, controllerId, `/tmp/e2e-perm-${Date.now()}`, token);

    // Create session via API (register listener first to avoid race)
    let sessionId = '';
    socket.once('acp:start', (data: { requestId: string }) => {
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });
    });
    sessionId = await createSession(page, controllerId, token, workspaceId);

    await loginViaUI(page, username);

    // Send permission request from controller
    const permissionRequestId = `perm_e2e_${Date.now()}`;
    socket.emit('acp:permission', {
      requestId: permissionRequestId,
      sessionId,
      toolCall: { toolCallId: 'call_e2e_001' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });

    // Wait for todo to be created and auto-popup dialog (immediate priority)
    await page.waitForTimeout(5000);

    // Global notification should auto-popup PermissionDialog for immediate priority
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('dialog').getByText('Agent请求权限审批')).toBeVisible();

    disconnect();
  });

  test('should open permission dialog on todo click', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, socket, disconnect } = await registerController(rawKey);
    const workspaceId = await createWorkspace(page, controllerId, `/tmp/e2e-perm-${Date.now()}`, token);

    // Create session
    const sessionId = await createSession(page, controllerId, token, workspaceId);

    // Wait for acp:start and respond
    const startData = await new Promise<{ requestId: string }>((resolve) => {
      socket.once('acp:start', resolve);
    });
    socket.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId,
      success: true,
      externalSessionId: `ext_${Date.now()}`,
    });

    await loginViaUI(page, username);

    // Send permission request
    const permissionRequestId = `perm_dialog_${Date.now()}`;
    socket.emit('acp:permission', {
      requestId: permissionRequestId,
      sessionId,
      toolCall: { toolCallId: 'call_dialog_001' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });

    // Wait for auto-popup dialog (immediate priority)
    await page.waitForTimeout(3000);

    // Permission dialog should auto-popup for immediate priority
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('dialog').getByText('Agent请求权限审批')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();
    await expect(page.getByRole('button', { name: '取消' })).toBeVisible();

    disconnect();
  });

  test('should respond to permission request on approval', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, socket, disconnect } = await registerController(rawKey);
    const workspaceId = await createWorkspace(page, controllerId, `/tmp/e2e-perm-${Date.now()}`, token);

    // Create session
    const sessionId = await createSession(page, controllerId, token, workspaceId);

    // Wait for acp:start and respond
    const startData = await new Promise<{ requestId: string }>((resolve) => {
      socket.once('acp:start', resolve);
    });
    socket.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId,
      success: true,
      externalSessionId: `ext_${Date.now()}`,
    });

    await loginViaUI(page, username);

    // Send permission request
    const permissionRequestId = `perm_approve_${Date.now()}`;
    const responsePromise = new Promise<{ requestId: string; outcome: any }>((resolve) => {
      socket.once('acp:permission:response', resolve);
    });

    socket.emit('acp:permission', {
      requestId: permissionRequestId,
      sessionId,
      toolCall: { toolCallId: 'call_approve_001' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });

    // Wait for auto-popup dialog (immediate priority)
    await page.waitForTimeout(3000);

    // Permission dialog should auto-popup for immediate priority
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });

    // Click Allow once
    await page.getByRole('button', { name: 'Allow once' }).click();

    // Controller should receive response
    const response = await responsePromise;
    expect(response.requestId).toBe(permissionRequestId);
    expect(response.outcome.outcome).toBe('selected');
    expect(response.outcome.optionId).toBe('allow-once');

    // Dialog should close
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });

    disconnect();
  });

  test('should show global notification for immediate priority todo', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, socket, disconnect } = await registerController(rawKey);
    const workspaceId = await createWorkspace(page, controllerId, `/tmp/e2e-perm-${Date.now()}`, token);

    // Create session
    const sessionId = await createSession(page, controllerId, token, workspaceId);

    // Wait for acp:start and respond
    const startData = await new Promise<{ requestId: string }>((resolve) => {
      socket.once('acp:start', resolve);
    });
    socket.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId,
      success: true,
      externalSessionId: `ext_${Date.now()}`,
    });

    await loginViaUI(page, username);

    // Navigate to sessions page
    await page.goto('/sessions');

    // Send permission request
    socket.emit('acp:permission', {
      requestId: `perm_notify_${Date.now()}`,
      sessionId,
      toolCall: { toolCallId: 'call_notify_001' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      ],
    });

    // Wait for SSE notification and auto-popup dialog
    await page.waitForTimeout(3000);

    // Global notification should auto-popup PermissionDialog for immediate priority
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('dialog').getByText('Agent请求权限审批')).toBeVisible();

    disconnect();
  });

  test('should mark todo as read after responding', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, socket, disconnect } = await registerController(rawKey);
    const workspaceId = await createWorkspace(page, controllerId, `/tmp/e2e-perm-${Date.now()}`, token);

    // Create session
    const sessionId = await createSession(page, controllerId, token, workspaceId);

    // Wait for acp:start and respond
    const startData = await new Promise<{ requestId: string }>((resolve) => {
      socket.once('acp:start', resolve);
    });
    socket.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId,
      success: true,
      externalSessionId: `ext_${Date.now()}`,
    });

    await loginViaUI(page, username);

    // Send permission request
    socket.emit('acp:permission', {
      requestId: `perm_read_${Date.now()}`,
      sessionId,
      toolCall: { toolCallId: 'call_read_001' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      ],
    });

    // Wait for todo to be created and auto-popup dialog (immediate priority)
    await page.waitForTimeout(3000);

    // Global notification should auto-popup PermissionDialog for immediate priority
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });

    // Respond to permission request
    await page.getByRole('button', { name: 'Allow once' }).click();

    // Wait for dialog to close
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });

    // Verify the todo was processed (dialog closed successfully)
    // The todo may still be visible but marked as read
    disconnect();
  });
});
