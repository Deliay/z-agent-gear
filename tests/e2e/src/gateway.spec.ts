import { test, expect } from '@playwright/test';
import { io as SocketIOClient } from 'socket.io-client';

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
  const username = `eg${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
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
  `, { input: { name: `e2e-gw-${Date.now()}`, type: 'local' } }, token);
  const body = await res.json();
  return { rawKey: body.data.createControllerKey.rawKey };
}

async function setupGatewayTest(page: import('@playwright/test').Page): Promise<{
  token: string;
  username: string;
  controllerId: string;
  disconnect: () => void;
  socket: import('socket.io-client').Socket;
}> {
  const { token, username } = await registerUser(page);
  const { rawKey } = await createControllerKey(page, token);
  const { controllerId, disconnect, socket } = await registerController(rawKey);
  return { token, username, controllerId, disconnect, socket };
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
    client.emit('register', { key: rawKey, hostname: 'e2e-gw-host', version: '2.0.0' });
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
  await sidebar.getByRole('button', { name: /e2e-gw-host/ }).click();
  return sidebar;
}

async function expandGateway(page: import('@playwright/test').Page) {
  const sidebar = page.locator('nav[aria-label="Sidebar"]');
  await sidebar.getByText('统一网关').click();
  return sidebar;
}

test.describe('Gateway E2E', () => {

  test('should show gateway section for online controller', async ({ page }) => {
    const { token, username, controllerId, disconnect } = await setupGatewayTest(page);

    await loginViaUI(page, username);
    const sidebar = await expandController(page);

    await expect(sidebar.getByText('统一网关')).toBeVisible({ timeout: 10000 });
    disconnect();
  });

  test('should show empty state when expanding gateways', async ({ page }) => {
    const { token, username, controllerId, disconnect } = await setupGatewayTest(page);

    await loginViaUI(page, username);
    await expandController(page);
    const sidebar = await expandGateway(page);

    await expect(sidebar.getByText('无网关暴露')).toBeVisible({ timeout: 10000 });
    disconnect();
  });

  test('should open gateway dialog', async ({ page }) => {
    const { token, username, controllerId, disconnect } = await setupGatewayTest(page);

    await loginViaUI(page, username);
    await expandController(page);
    await expandGateway(page);

    const sidebar = page.locator('nav[aria-label="Sidebar"]');
    await sidebar.getByRole('button', { name: '+', exact: true }).click();

    await expect(page.getByText('新建网关暴露')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('input[type="text"]')).toBeVisible();
    await expect(page.locator('input[type="number"]')).toBeVisible();
    await expect(page.getByText('取消')).toBeVisible();
    await expect(page.getByRole('button', { name: '创建', exact: true })).toBeVisible();

    await page.getByText('取消').click();
    await expect(page.getByText('新建网关暴露')).not.toBeVisible();
    disconnect();
  });

  test('should create a gateway', async ({ page }) => {
    const { token, username, controllerId, disconnect } = await setupGatewayTest(page);

    await loginViaUI(page, username);
    await expandController(page);
    await expandGateway(page);

    const sidebar = page.locator('nav[aria-label="Sidebar"]');
    await sidebar.getByRole('button', { name: '+', exact: true }).click();

    await page.locator('input[type="text"]').fill('my-api');
    await page.locator('input[type="number"]').fill('3000');
    await page.getByRole('button', { name: '创建', exact: true }).click();

    await expect(page.getByText('新建网关暴露')).not.toBeVisible({ timeout: 5000 });
    await expect(sidebar.getByText('my-api', { exact: true })).toBeAttached({ timeout: 15000 });
    await expect(sidebar.getByText(':3000')).toBeAttached({ timeout: 5000 });
    await expect(sidebar.getByText('active')).toBeAttached({ timeout: 5000 });

    disconnect();
  });

  test('should show error for duplicate name', async ({ page }) => {
    const { token, username, controllerId, disconnect } = await setupGatewayTest(page);

    await loginViaUI(page, username);
    await expandController(page);
    await expandGateway(page);

    const sidebar = page.locator('nav[aria-label="Sidebar"]');

    await sidebar.getByRole('button', { name: '+', exact: true }).click();
    await page.locator('input[type="text"]').fill('dup-svc');
    await page.locator('input[type="number"]').fill('3001');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByText('新建网关暴露')).not.toBeVisible({ timeout: 5000 });
    await expect(sidebar.getByText('dup-svc')).toBeAttached({ timeout: 15000 });

    await sidebar.getByRole('button', { name: '+', exact: true }).click();
    await page.locator('input[type="text"]').fill('dup-svc');
    await page.locator('input[type="number"]').fill('3002');
    await page.getByRole('button', { name: '创建', exact: true }).click();

    await expect(page.locator('.text-destructive')).toBeVisible({ timeout: 10000 });

    await page.getByText('取消').click();
    disconnect();
  });

  test('should delete a gateway', async ({ page }) => {
    const { token, username, controllerId, disconnect } = await setupGatewayTest(page);

    await loginViaUI(page, username);
    await expandController(page);
    await expandGateway(page);

    const sidebar = page.locator('nav[aria-label="Sidebar"]');

    await sidebar.getByRole('button', { name: '+', exact: true }).click();
    await page.locator('input[type="text"]').fill('del-svc');
    await page.locator('input[type="number"]').fill('4000');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await expect(sidebar.getByText('del-svc')).toBeAttached({ timeout: 15000 });

    await sidebar.getByTitle('删除网关暴露').click();
    await expect(sidebar.getByText('del-svc')).not.toBeAttached({ timeout: 15000 });
    await expect(sidebar.getByText('无网关暴露')).toBeVisible({ timeout: 5000 });

    disconnect();
  });

  test('should close dialog on cancel', async ({ page }) => {
    const { token, username, controllerId, disconnect } = await setupGatewayTest(page);

    await loginViaUI(page, username);
    await expandController(page);
    await expandGateway(page);

    const sidebar = page.locator('nav[aria-label="Sidebar"]');
    await sidebar.getByRole('button', { name: '+', exact: true }).click();

    await expect(page.getByText('新建网关暴露')).toBeVisible({ timeout: 5000 });
    await page.getByText('取消').click();
    await expect(page.getByText('新建网关暴露')).not.toBeVisible();

    disconnect();
  });

  test('should not show gateway section for offline controller', async ({ page }) => {
    const { token, username, controllerId, disconnect } = await setupGatewayTest(page);

    disconnect();

    await loginViaUI(page, username);

    const sidebar = page.locator('nav[aria-label="Sidebar"]');

    // Wait for controller to become offline in the UI (via 15s polling)
    await expect(async () => {
      await sidebar.getByRole('button', { name: /e2e-gw-host/ }).click();
      const statusDot = sidebar.locator('span.h-2.w-2.rounded-full.bg-muted-foreground');
      await expect(statusDot.first()).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15000, intervals: [1000] });

    await expect(sidebar.getByText('统一网关')).not.toBeVisible({ timeout: 5000 });
  });

});

test.describe('Gateway Tunnel E2E', () => {
  const PROXY_BASE = API_URL.replace('/graphql', '');

  test('should create gateway and proxy request through tunnel successfully', async ({ page }) => {
    const { token, controllerId, disconnect, socket } = await setupGatewayTest(page);

    let capturedTunnelId = '';
    socket.on('port-forward:data', (data: { tunnelId: string; data: string }) => {
      capturedTunnelId = data.tunnelId;
      const parsedRequest = JSON.parse(Buffer.from(data.data, 'base64').toString());
      const responseData = JSON.stringify({
        type: 'http-response',
        requestId: parsedRequest.requestId,
        body: Buffer.from(
          'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nHello from gateway tunnel!',
        ).toString('base64'),
      });
      socket.emit('port-forward:data', {
        tunnelId: data.tunnelId,
        data: Buffer.from(responseData).toString('base64'),
      });
    });

    const gwName = `tun-svc-${Date.now().toString(36)}`;
    const gwPort = 18888;

    const gwRes = await gqlRequest(page, `
      mutation CreateGw($controllerId: ID!, $name: String!, $port: Int!) {
        createGateway(controllerId: $controllerId, name: $name, port: $port) { id name port status }
      }
    `, { controllerId, name: gwName, port: gwPort }, token);
    const gwBody = await gwRes.json();
    expect(gwBody.errors).toBeUndefined();
    expect(gwBody.data.createGateway.name).toBe(gwName);
    expect(gwBody.data.createGateway.status).toBe('active');

    // Make proxy request through gateway tunnel (retry on 502 until tunnel is established)
    const proxyUrl = `${PROXY_BASE}/api/gateway/${controllerId}/${gwName}/hello`;
    let proxyRes: import('@playwright/test').APIResponse | undefined;
    await expect(async () => {
      const res = await page.request.get(proxyUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status() !== 502) {
        proxyRes = res;
      }
      expect(res.status()).not.toBe(502);
    }).toPass({ timeout: 15000, intervals: [1000] });

    expect(proxyRes!.status()).toBe(200);
    const proxyText = await proxyRes!.text();
    expect(proxyText).toBe('Hello from gateway tunnel!');

    if (capturedTunnelId) {
      socket.emit('port-forward:close', { tunnelId: capturedTunnelId });
    }
    disconnect();
  });
});
