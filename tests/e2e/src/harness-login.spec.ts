import { test, expect } from '@playwright/test';
import { io as SocketIOClient, type Socket } from 'socket.io-client';

// Kimi Code（Harness）登录引导 E2E（T-E-HL1~7）。
// fake controller 注入 `harness:login:required/succeeded/failed` 驱动全局弹窗；
// 真实 `kimi login` 浏览器授权不可自动化（计划 §3 A20 / §6.4）。
const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';
const HARNESS_ENABLED = process.env.HARNESS_ENABLED === 'true';

const LOGIN_URL = 'https://www.kimi.com/code/authorize_device?user_code=E2E9-8888';
const LOGIN_CODE = 'E2E9-8888';

function gqlRequest(
  page: import('@playwright/test').Page,
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return page.request.post(API_URL, { headers, data: { query, variables } });
}

async function registerUser(
  page: import('@playwright/test').Page,
): Promise<{ token: string; username: string }> {
  const username = `hl${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
  const res = await gqlRequest(
    page,
    `mutation Signup($username: String!, $password: String!) {
      signup(username: $username, password: $password) { token user { id } }
    }`,
    { username, password: 'testpass123' },
  );
  const body = await res.json();
  return { token: body.data.signup.token as string, username };
}

interface FakeController {
  controllerId: string;
  socket: Socket;
  disconnect: () => void;
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await page.locator('nav[aria-label="Sidebar"]').waitFor({ timeout: 10000 });
}

async function createControllerKey(
  page: import('@playwright/test').Page,
  token: string,
): Promise<string> {
  const res = await gqlRequest(
    page,
    `mutation CreateKey($input: CreateKeyInput!) {
      createControllerKey(input: $input) { rawKey }
    }`,
    { input: { name: `e2e-hl-${Date.now()}`, type: 'local' } },
    token,
  );
  const body = await res.json();
  return body.data.createControllerKey.rawKey as string;
}

function registerController(rawKey: string): Promise<FakeController> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error('Timeout registering fake controller'));
    }, 10000);

    // OpenCode 零回归：普通探测正常返回，不触发任何登录弹窗
    client.on('acp:probe-options', (data: { requestId: string; serverType?: string }) => {
      client.emit('acp:probe-options:result', {
        requestId: data.requestId,
        serverType: data.serverType ?? 'opencode',
        success: true,
        modes: [],
        models: [],
      });
    });

    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve({
        controllerId: data.controllerId,
        socket: client,
        disconnect: () => client.disconnect(),
      });
    });
    client.once('error', (data: { message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Failed to register: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname: 'e2e-hl-host', version: '2.8.0' });
  });
}

function emitRequired(
  controller: FakeController,
  requestId: string,
  overrides: Record<string, unknown> = {},
) {
  controller.socket.emit('harness:login:required', {
    requestId,
    serverType: 'kimi_code',
    trigger: 'probe-options',
    url: LOGIN_URL,
    userCode: LOGIN_CODE,
    expiresInSeconds: 1800,
    ...overrides,
  });
}

async function setup(page: import('@playwright/test').Page): Promise<{
  token: string;
  controller: FakeController;
  requestId: string;
}> {
  const { token, username } = await registerUser(page);
  const rawKey = await createControllerKey(page, token);
  const controller = await registerController(rawKey);
  await loginViaUI(page, username);
  return { token, controller, requestId: `hl_e2e_${Date.now()}` };
}

test.describe('Harness Login E2E', () => {
  test.skip(!HARNESS_ENABLED, 'HARNESS_ENABLED=false：云电脑入口关闭');
  test.setTimeout(60000);

  test('T-E-HL1/T-E-HL2: 弹窗即时呈现，成功后自动关闭并提示', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const { controller, requestId } = await setup(page);

    try {
      // 不刷新、不切页：SSE 即时下发
      emitRequired(controller, requestId);
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Kimi Code 需要登录' })).toBeVisible({
        timeout: 15000,
      });
      await expect(dialog.getByTestId('harness-login-url')).toHaveText(LOGIN_URL);
      await expect(dialog.getByTestId('harness-login-code')).toHaveText(LOGIN_CODE);
      await expect(dialog.getByRole('status')).toContainText('等待授权完成');
      await expect(dialog.getByRole('status')).toContainText('剩余');

      const link = dialog.getByRole('link', { name: '打开登录链接' });
      await expect(link).toHaveAttribute('href', LOGIN_URL);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noreferrer/);

      await dialog.getByRole('button', { name: '复制链接' }).click();
      await expect(dialog.getByText('已复制')).toBeVisible();
      await dialog.getByRole('button', { name: '复制验证码' }).click();

      controller.socket.emit('harness:login:succeeded', {
        requestId,
        account: 'managed:kimi-code',
      });
      await expect(dialog).toHaveCount(0, { timeout: 15000 });
      await expect(page.getByText('Kimi Code 已登录')).toBeVisible({ timeout: 10000 });
    } finally {
      controller.disconnect();
    }
  });

  test('T-E-HL3: 取消下发 controller，提示未登录后再次触发可重新弹出', async ({ page }) => {
    const { controller, requestId } = await setup(page);
    const retryId = `${requestId}_retry`;

    try {
      emitRequired(controller, requestId);
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Kimi Code 需要登录' })).toBeVisible({
        timeout: 15000,
      });

      const cancelEvent = new Promise<{ requestId: string }>((resolve) => {
        controller.socket.once('harness:login:cancel', resolve);
      });
      await dialog.getByRole('button', { name: '取消' }).click();
      await expect(dialog).toHaveCount(0, { timeout: 5000 });
      await expect(cancelEvent).resolves.toMatchObject({ requestId });

      controller.socket.emit('harness:login:failed', { requestId, reason: 'cancelled' });
      await expect(page.getByText('Kimi Code 未登录')).toBeVisible({ timeout: 10000 });

      // 注册表已清除：再次注入 required 可重新弹出
      emitRequired(controller, retryId);
      await expect(dialog.getByRole('heading', { name: 'Kimi Code 需要登录' })).toBeVisible({
        timeout: 15000,
      });
    } finally {
      controller.disconnect();
    }
  });

  test('T-E-HL4: 过期提示可重试且隐藏操作', async ({ page }) => {
    const { controller, requestId } = await setup(page);
    try {
      emitRequired(controller, requestId);
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Kimi Code 需要登录' })).toBeVisible({
        timeout: 15000,
      });

      controller.socket.emit('harness:login:failed', { requestId, reason: 'timeout' });
      await expect(page.getByText('登录未完成，可重试')).toBeVisible({ timeout: 10000 });
      await expect(dialog).toHaveCount(0, { timeout: 5000 });
      await expect(page.getByRole('button', { name: '取消' })).toHaveCount(0);
    } finally {
      controller.disconnect();
    }
  });

  test('T-E-HL5: 移动视口下弹窗可见、无横向溢出且可操作', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const { controller, requestId } = await setup(page);
    try {
      emitRequired(controller, requestId);
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Kimi Code 需要登录' })).toBeVisible({
        timeout: 15000,
      });
      await expect(dialog.getByTestId('harness-login-code')).toHaveText(LOGIN_CODE);

      const box = await dialog.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(376);

      await dialog.getByRole('button', { name: '取消' }).click();
      await expect(dialog).toHaveCount(0, { timeout: 5000 });
    } finally {
      controller.disconnect();
    }
  });

  test('T-E-HL6: OpenCode 探测零弹窗', async ({ page }) => {
    const { token, controller } = await setup(page);
    try {
      const res = await gqlRequest(
        page,
        `query Probe($controllerId: ID!, $acpServerType: AcpServerType!) {
          acpServerOptions(controllerId: $controllerId, acpServerType: $acpServerType) {
            modes { id }
            models { id }
          }
        }`,
        { controllerId: controller.controllerId, acpServerType: 'opencode' },
        token,
      );
      const body = await res.json();
      expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByText('Kimi Code 需要登录')).toHaveCount(0);
    } finally {
      controller.disconnect();
    }
  });
});
