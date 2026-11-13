import { test, expect } from '@playwright/test';
import { io as SocketIOClient, type Socket } from 'socket.io-client';
import { registerUser } from './helpers';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return page.request.post(API_URL, { headers, data: body });
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
      resolve({ controllerId: data.controllerId, socket: client, disconnect: () => client.disconnect() });
    });
    client.once('error', (data: { code: string; message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname: 'e2e-elic-host', version: '2.0.0' });
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

/** 通知弹窗 → 跳转会话 → 返回卡片 locator（PRD 功能点 5：表单只在卡片） */
async function openInteractionCard(page: import('@playwright/test').Page, requestId: string) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 25000 });
  await dialog.getByRole('button', { name: '前往会话处理' }).click();
  const card = page.locator(`[data-interaction-id="${requestId}"]`);
  await expect(card).toBeVisible({ timeout: 25000 });
  return card;
}

test.describe('ACP Elicitation E2E', () => {
  // 待办并入 homeOverview 后统一 15s 轮询，放宽单测超时
  test.setTimeout(60000);

  test('E2E-SI1: 通知弹窗跳转会话卡片，填写提交后卡片禁用并回显提交内容', async ({ page }) => {
    const { socket, sessionId, disconnect } = await setupSession(page);

    const requestId = `elic_form_e2e_${Date.now()}`;
    const responsePromise = new Promise<{ requestId: string; action: string; content?: Record<string, unknown> }>((resolve) => {
      socket.once('acp:elicitation:response', resolve);
    });

    socket.emit('acp:elicitation', {
      requestId,
      sessionId,
      mode: 'form',
      message: 'How should I approach this refactoring?',
      requestedSchema: FORM_SCHEMA,
    });

    // 弹窗降级为通知：无表单字段，只提供跳转
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 25000 });
    await expect(dialog.getByText('Agent请求输入：重构策略')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '提交' })).toHaveCount(0);

    await dialog.getByRole('button', { name: '前往会话处理' }).click();
    const card = page.locator(`[data-interaction-id="${requestId}"]`);
    await expect(card).toBeVisible({ timeout: 25000 });
    await expect(card.getByTestId('interaction-countdown')).toBeVisible();

    // 必答项未填时不可提交
    await expect(card.getByRole('button', { name: '提交' })).toBeDisabled();
    await card.getByText('balanced').click();
    await card.getByRole('button', { name: '提交' }).click();

    const response = await responsePromise;
    expect(response.requestId).toBe(requestId);
    expect(response.action).toBe('accept');
    expect(response.content).toEqual({ strategy: 'balanced', dryRun: true });

    // 终态：禁用并回显提交内容
    await expect(card.getByTestId('interaction-status')).toHaveText('已提交');
    await expect(card.getByRole('button', { name: '提交' })).toHaveCount(0);
    await expect(card.getByTestId('interaction-submitted')).toContainText('balanced');

    disconnect();
  });

  test('E2E-SI1b: 卡片内拒绝动作回传 controller', async ({ page }) => {
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

    const card = await openInteractionCard(page, requestId);
    await card.getByRole('button', { name: '拒绝' }).click();

    const response = await responsePromise;
    expect(response.requestId).toBe(requestId);
    expect(response.action).toBe('decline');
    expect(response.content).toBeUndefined();
    await expect(card.getByTestId('interaction-status')).toHaveText('已拒绝');

    disconnect();
  });

  test('E2E-SI1c: 卡片内取消动作回传 controller', async ({ page }) => {
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

    const card = await openInteractionCard(page, requestId);
    await card.getByRole('button', { name: '取消' }).click();

    const response = await responsePromise;
    expect(response.requestId).toBe(requestId);
    expect(response.action).toBe('cancel');

    disconnect();
  });

  test('E2E-SI2: resolved(timeout) 后卡片收敛为已过期且禁用', async ({ page }) => {
    const { socket, sessionId, disconnect } = await setupSession(page);

    const requestId = `elic_timeout_e2e_${Date.now()}`;
    socket.emit('acp:elicitation', {
      requestId,
      sessionId,
      mode: 'form',
      message: 'Timeout card',
      requestedSchema: FORM_SCHEMA,
    });

    const card = await openInteractionCard(page, requestId);
    socket.emit('acp:elicitation:resolved', {
      requestId,
      sessionId,
      reason: 'timeout',
      detail: 'controller-api timeout (60s)',
    });

    await expect(card.getByTestId('interaction-status')).toHaveText('已过期', { timeout: 25000 });
    await expect(card.getByRole('button', { name: '提交' })).toHaveCount(0);

    disconnect();
  });

  test('E2E-QM1: question 工具多选题在卡片中呈现为勾选组并以逗号拼接回传', async ({ page }) => {
    const { socket, sessionId, disconnect } = await setupSession(page);

    const QUESTION_SCHEMA = {
      type: 'object',
      title: '实施选项',
      properties: {
        q0: {
          type: 'string',
          title: '实施方式',
          oneOf: [
            { const: '自动', title: '自动' },
            { const: '手动', title: '手动' },
          ],
        },
        q0_custom: { type: 'string', title: '其他实施方式' },
        q1: {
          type: 'array',
          title: '要做的事',
          items: {
            anyOf: [
              { const: '自动跑测试', title: '自动跑测试' },
              { const: '生成文档', title: '生成文档' },
              { const: '部署', title: '部署' },
            ],
          },
        },
        q1_custom: { type: 'string', title: '其他要做的事' },
      },
      required: ['q0', 'q1'],
    };

    const requestId = `elic_multi_e2e_${Date.now()}`;
    const responsePromise = new Promise<{ requestId: string; action: string; content?: Record<string, unknown> }>((resolve) => {
      socket.once('acp:elicitation:response', resolve);
    });

    socket.emit('acp:elicitation', {
      requestId,
      sessionId,
      mode: 'form',
      message: '请选择实施选项',
      requestedSchema: QUESTION_SCHEMA,
    });

    const card = await openInteractionCard(page, requestId);
    const group = card.getByRole('group', { name: '要做的事' });
    await expect(group).toBeVisible();
    await expect(group.getByRole('checkbox')).toHaveCount(3);

    await expect(card.getByRole('button', { name: '提交' })).toBeDisabled();

    await card.getByRole('radiogroup', { name: '实施方式' }).getByText('自动', { exact: true }).click();
    await group.getByText('自动跑测试', { exact: true }).click();
    await group.getByText('生成文档', { exact: true }).click();
    await card.getByRole('button', { name: '提交', exact: true }).click();

    const response = await responsePromise;
    expect(response.requestId).toBe(requestId);
    expect(response.action).toBe('accept');
    expect(response.content).toEqual({ q0: '自动', q1: '自动跑测试,生成文档' });

    await expect(card.getByTestId('interaction-status')).toHaveText('已提交');

    disconnect();
  });

  test('should show url elicitation with highlighted host and open link on consent', async ({ page }) => {
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

    const card = await openInteractionCard(page, requestId);
    await expect(card.getByText('Please authorize access to your repositories.')).toBeVisible();
    await expect(card.getByText('agent.example.com')).toBeVisible();

    await card.getByRole('button', { name: '打开链接' }).click();

    const openedUrls = await page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls);
    expect(openedUrls).toEqual([targetUrl]);

    const response = await responsePromise;
    expect(response.requestId).toBe(requestId);
    expect(response.action).toBe('accept');

    disconnect();
  });
});
