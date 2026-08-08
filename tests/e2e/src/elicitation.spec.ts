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

async function registerUser(page: import('@playwright/test').Page): Promise<{ token: string; username: string }> {
  const username = `el${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
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
  `, { input: { name: `e2e-elic-${Date.now()}`, type: 'local' } }, token);
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
    client.emit('register', { key: rawKey, hostname: 'e2e-elic-host', version: '1.0.0' });
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

const FORM_SCHEMA = {
  type: 'object',
  title: '重构策略',
  properties: {
    strategy: { type: 'string', enum: ['conservative', 'balanced', 'aggressive'] },
    dryRun: { type: 'boolean', title: '仅试运行', default: true },
  },
  required: ['strategy'],
};

async function setupSession(page: import('@playwright/test').Page): Promise<{ socket: Socket; sessionId: string; disconnect: () => void }> {
  const { token, username } = await registerUser(page);
  const { rawKey } = await createControllerKey(page, token);
  const { controllerId, socket, disconnect } = await registerController(rawKey);
  const workspaceId = await createWorkspace(page, controllerId, `/tmp/e2e-elic-${Date.now()}`, token);

  // Create session (register listener first to avoid race)
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
  return { socket, sessionId, disconnect };
}

test.describe('ACP Elicitation E2E', () => {
  test('should auto-popup form elicitation dialog and submit values', async ({ page }) => {
    const { socket, sessionId, disconnect } = await setupSession(page);

    const requestId = `elic_form_e2e_${Date.now()}`;
    const responsePromise = new Promise<{ requestId: string; action: string; content?: Record<string, unknown> }>((resolve) => {
      socket.once('acp:elicitation:response', resolve);
    });

    // Agent asks a question via elicitation (form mode)
    socket.emit('acp:elicitation', {
      requestId,
      sessionId,
      mode: 'form',
      message: 'How should I approach this refactoring?',
      requestedSchema: FORM_SCHEMA,
    });

    // Wait for auto-popup dialog (immediate priority todo)
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog.getByText('Agent请求输入：重构策略')).toBeVisible();
    await expect(dialog.getByText('How should I approach this refactoring?')).toBeVisible();

    // Required field blocks submission until filled
    await expect(dialog.getByRole('button', { name: '提交' })).toBeDisabled();

    // Select a strategy and submit
    await dialog.getByText('balanced').click();
    await dialog.getByRole('button', { name: '提交' }).click();

    // Controller should receive the accept response with form content
    const response = await responsePromise;
    expect(response.requestId).toBe(requestId);
    expect(response.action).toBe('accept');
    expect(response.content).toEqual({ strategy: 'balanced', dryRun: true });

    // Dialog should close
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    disconnect();
  });

  test('should relay decline action to controller', async ({ page }) => {
    const { socket, sessionId, disconnect } = await setupSession(page);

    const requestId = `elic_decline_e2e_${Date.now()}`;
    const responsePromise = new Promise<{ requestId: string; action: string; content?: unknown }>((resolve) => {
      socket.once('acp:elicitation:response', resolve);
    });

    socket.emit('acp:elicitation', {
      requestId,
      sessionId,
      mode: 'form',
      message: 'How should I approach this refactoring?',
      requestedSchema: FORM_SCHEMA,
    });

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    await dialog.getByRole('button', { name: '拒绝' }).click();

    const response = await responsePromise;
    expect(response.requestId).toBe(requestId);
    expect(response.action).toBe('decline');
    expect(response.content).toBeUndefined();

    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    disconnect();
  });

  test('should relay cancel action to controller', async ({ page }) => {
    const { socket, sessionId, disconnect } = await setupSession(page);

    const requestId = `elic_cancel_e2e_${Date.now()}`;
    const responsePromise = new Promise<{ requestId: string; action: string }>((resolve) => {
      socket.once('acp:elicitation:response', resolve);
    });

    socket.emit('acp:elicitation', {
      requestId,
      sessionId,
      mode: 'form',
      message: 'How should I approach this refactoring?',
      requestedSchema: FORM_SCHEMA,
    });

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    await dialog.getByRole('button', { name: '取消' }).click();

    const response = await responsePromise;
    expect(response.requestId).toBe(requestId);
    expect(response.action).toBe('cancel');

    disconnect();
  });

  test('should show url elicitation with highlighted host and open link on consent', async ({ page }) => {
    // Stub window.open to capture the URL instead of opening a real tab
    await page.addInitScript(() => {
      (window as unknown as { __openedUrls: string[] }).__openedUrls = [];
      window.open = (url?: string | URL) => {
        (window as unknown as { __openedUrls: string[] }).__openedUrls.push(String(url));
        return null;
      };
    });

    const { socket, sessionId, disconnect } = await setupSession(page);

    const requestId = `elic_url_e2e_${Date.now()}`;
    const elicitationId = `oauth_e2e_${Date.now()}`;
    const targetUrl = `https://agent.example.com/connect?elicitationId=${elicitationId}`;
    const responsePromise = new Promise<{ requestId: string; action: string }>((resolve) => {
      socket.once('acp:elicitation:response', resolve);
    });

    socket.emit('acp:elicitation', {
      requestId,
      sessionId,
      mode: 'url',
      message: 'Please authorize access to your repositories.',
      elicitationId,
      url: targetUrl,
    });

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog.getByText('Agent请求输入：打开链接授权')).toBeVisible();
    await expect(dialog.getByText('Please authorize access to your repositories.')).toBeVisible();
    // Full URL is displayed (host highlighted) before asking for consent
    await expect(dialog.getByText('agent.example.com')).toBeVisible();

    await dialog.getByRole('button', { name: '打开链接' }).click();

    // URL opened in a new tab only after explicit consent
    const openedUrls = await page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls);
    expect(openedUrls).toEqual([targetUrl]);

    // Consent (accept) is relayed to the controller
    const response = await responsePromise;
    expect(response.requestId).toBe(requestId);
    expect(response.action).toBe('accept');

    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    disconnect();
  });
});
