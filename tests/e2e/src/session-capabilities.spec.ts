import { test, expect } from '@playwright/test';
import { io as SocketIOClient, type Socket } from 'socket.io-client';
import mongoose from 'mongoose';
// FeatureId 唯一事实源：直接引用 agent-controller 的能力清单，禁止测试手抄复制
import { FEATURE_IDS } from '../../../packages/agent-controller/src/acp/capabilities.js';


const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';
const MONGODB_URI = process.env.MONGODB_URI || '';

function makeCapabilities(overrides: Record<string, 'supported' | 'partial' | 'unsupported'> = {}) {
  return {
    protocolVersion: 1,
    agentInfo: { name: 'OpenCode', version: '2.0.31' },
    features: FEATURE_IDS.map((id) => ({
      id,
      status: overrides[id] ?? (id === 'prompt.audio' ? 'unsupported' : 'supported'),
      detail: overrides[id] === 'unsupported'
        ? `未声明 ${id}`
        : id === 'prompt.audio' ? '未声明 agentCapabilities.promptCapabilities.audio' : null,
    })),
    raw: {
      agentCapabilities: { loadSession: true },
      authMethods: [],
      clientCapabilities: { elicitation: { form: {}, url: {} } },
    },
  };
}

async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return page.request.post(API_URL, { headers, data: body });
}

async function registerUser(page: import('@playwright/test').Page): Promise<{ token: string; username: string }> {
  const username = `cap${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
  const res = await gqlRequest(page, `
    mutation Signup($username: String!, $password: String!) {
      signup(username: $username, password: $password) { token user { id username } }
    }
  `, { username, password: 'testpass123' });
  const body = await res.json();
  return { token: body.data.signup.token, username };
}

async function createControllerKey(page: import('@playwright/test').Page, token: string): Promise<string> {
  const res = await gqlRequest(page, `
    mutation CreateKey($input: CreateKeyInput!) {
      createControllerKey(input: $input) { rawKey key { id } }
    }
  `, { input: { name: `e2e-cap-${Date.now()}`, type: 'local' } }, token);
  const body = await res.json();
  return body.data.createControllerKey.rawKey;
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

    client.on('git:worktree:list', (data: { requestId: string }) => {
      client.emit('git:worktree:list:result', { requestId: data.requestId, success: true, worktrees: [] });
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
    client.once('error', (data: { message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname: 'e2e-cap-host', version: '2.0.0' });
  });
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await page.locator('nav[aria-label="Sidebar"]').waitFor({ timeout: 10000 });
}

async function createWorkspace(page: import('@playwright/test').Page, controllerId: string, token: string): Promise<string> {
  const res = await gqlRequest(page, `
    mutation CreateWorkspace($input: CreateWorkspaceInput!) {
      createWorkspace(input: $input) { id }
    }
  `, { input: { controllerId, path: `/tmp/e2e-cap-${Date.now()}` } }, token);
  const body = await res.json();
  return body.data.createWorkspace.id;
}

interface SetupOptions {
  capabilities?: Record<string, unknown>;
  modes?: Array<{ id: string; name: string }>;
  availableModels?: Array<{ id: string; name: string }>;
  currentModelId?: string;
}

async function setupSession(
  page: import('@playwright/test').Page,
  options: SetupOptions = {},
): Promise<{
  socket: Socket;
  sessionId: string;
  token: string;
  username: string;
  controllerId: string;
  disconnect: () => void;
}> {
  const { token, username } = await registerUser(page);
  const rawKey = await createControllerKey(page, token);
  const { controllerId, socket, disconnect } = await registerController(rawKey);
  const workspaceId = await createWorkspace(page, controllerId, token);

  let sessionId = '';
  let resolveSessionId!: (id: string) => void;
  const sessionIdReady = new Promise<string>((resolve) => { resolveSessionId = resolve; });
  // acp:start 可能早于 createSession 响应到达：先等 sessionId 赋值，避免上报空 sessionId（假红 flaky）
  socket.once('acp:start', async (data: { requestId: string }) => {
    const sid = await sessionIdReady;
    socket.emit('acp:start:result', {
      requestId: data.requestId,
      sessionId: sid,
      success: true,
      externalSessionId: `ext_${Date.now()}`,
      modes: options.modes ?? [],
      ...(options.modes?.length ? { currentModeId: options.modes[0].id } : {}),
      availableModels: options.availableModels ?? [],
      ...(options.currentModelId ? { currentModelId: options.currentModelId } : {}),
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    });
  });

  const res = await gqlRequest(page, `
    mutation CreateSession($input: CreateSessionInput!) {
      createSession(input: $input) { session { id } }
    }
  `, { input: { controllerId, acpServerType: 'opencode', workspaceId } }, token);
  const body = await res.json();
  sessionId = body.data.createSession.session.id;
  resolveSessionId(sessionId);

  await loginViaUI(page, username);
  return { socket, sessionId, token, username, controllerId, disconnect };
}

async function openSessionPage(page: import('@playwright/test').Page, sessionId: string) {
  await page.goto(`/sessions/${sessionId}`);
  await page.locator('[data-testid="session-status-badge"]').waitFor({ timeout: 15000 });
}

test.describe('ACP 能力透明化 E2E', () => {
  test.setTimeout(90000);

  test('T-E31: 能力面板展示 20 项状态、detail 与 Agent 版本', async ({ page }) => {
    const { sessionId, disconnect } = await setupSession(page, {
      capabilities: makeCapabilities({ 'prompt.image': 'partial' }),
    });
    await openSessionPage(page, sessionId);

    await page.getByLabel('能力清单').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Agent：OpenCode 2.0.31')).toBeVisible();
    // 20 项固定清单：数量与顺序都必须被实证（面板只渲染 5 行/漏项会红）
    const rows = dialog.locator('[data-testid^="agent-capability-row-"]');
    await expect(rows).toHaveCount(20);
    await expect(page.getByTestId('agent-capability-row-session.load')).toBeVisible();
    await expect(page.getByTestId('agent-capability-status-elicitation.form')).toHaveText('支持');
    await expect(page.getByTestId('agent-capability-status-prompt.image')).toHaveText('部分支持');
    await expect(page.getByTestId('agent-capability-status-prompt.audio')).toHaveText('不支持');
    // detail 列必须真实展示（unsupported 原因文案）
    await expect(page.getByTestId('agent-capability-row-prompt.audio'))
      .toContainText('未声明 agentCapabilities.promptCapabilities.audio');

    disconnect();
  });

  test('T-E32: 旧会话（无 capabilities）显示快照上线前提示', async ({ page }) => {
    const { sessionId, disconnect } = await setupSession(page, {});
    await openSessionPage(page, sessionId);

    await page.getByLabel('能力清单').click();
    await expect(page.getByTestId('agent-capability-empty')).toContainText('创建于能力快照上线前');

    disconnect();
  });

  test('T-E33: config.model 明确 unsupported 时模型按钮禁用并展示原因', async ({ page }) => {
    const { sessionId, disconnect } = await setupSession(page, {
      capabilities: makeCapabilities({ 'config.model': 'unsupported' }),
      availableModels: [{ id: 'gpt-4o', name: 'GPT-4o' }],
      currentModelId: 'gpt-4o',
    });
    await openSessionPage(page, sessionId);

    const modelButton = page.getByTitle(/未声明 config.model/);
    await expect(modelButton).toBeVisible();
    await expect(modelButton).toBeDisabled();

    disconnect();
  });

  test('T-E34: config.mode 明确 unsupported 时模式按钮禁用', async ({ page }) => {
    const { sessionId, disconnect } = await setupSession(page, {
      capabilities: makeCapabilities({ 'config.mode': 'unsupported' }),
      modes: [{ id: 'build', name: 'Build' }],
    });
    await openSessionPage(page, sessionId);

    const modeButton = page.getByTitle(/未声明 config.mode/);
    await expect(modeButton).toBeVisible();
    await expect(modeButton).toBeDisabled();

    disconnect();
  });

  test('T-E35: resume+load 均 unsupported 时「继续」禁用；load supported 时可用', async ({ page }) => {
    const blocked = await setupSession(page, {
      capabilities: makeCapabilities({ 'session.resume': 'unsupported', 'session.load': 'unsupported' }),
    });
    await openSessionPage(page, blocked.sessionId);
    await gqlRequest(page, `mutation($id: ID!) { closeSession(id: $id) }`, { id: blocked.sessionId }, blocked.token);
    await page.reload();
    const disabledContinue = page.getByRole('button', { name: '继续' });
    await expect(disabledContinue).toBeDisabled();
    await expect(disabledContinue).toHaveAttribute('title', '当前 Agent 不支持会话恢复');
    blocked.disconnect();

    const allowed = await setupSession(page, {
      capabilities: makeCapabilities({ 'session.resume': 'unsupported' }),
    });
    await openSessionPage(page, allowed.sessionId);
    await gqlRequest(page, `mutation($id: ID!) { closeSession(id: $id) }`, { id: allowed.sessionId }, allowed.token);
    await page.reload();
    await expect(page.getByRole('button', { name: '继续' })).toBeEnabled();
    allowed.disconnect();
  });

  test('T-E36: 模型来源分组（平台内置/自定义/Agent 自带/来源未知）', async ({ page }) => {
    // 唯一集成级验收：缺 MONGODB_URI 直接失败，禁止静默 skip 冒充通过
    expect(MONGODB_URI, 'MONGODB_URI 必须注入（aspire describe mongodb），T-E36 不允许静默 skip').toBeTruthy();

    await mongoose.connect(MONGODB_URI);
    const suffix = Date.now().toString(36);
    const globalName = `e2e-platform-${suffix}`;
    const userName = `e2e-custom-${suffix}`;
    const providerId = new mongoose.Types.ObjectId();
    const collection = mongoose.connection.collection('models');
    await collection.insertMany([
      { providerId, name: globalName, scope: 'global', isEnabled: true, isCustom: false, sortOrder: 0, createdAt: new Date(), updatedAt: new Date() },
      { providerId, name: userName, scope: 'user', isEnabled: true, isCustom: true, sortOrder: 0, createdAt: new Date(), updatedAt: new Date() },
    ]);

    try {
      const { sessionId, disconnect } = await setupSession(page, {
        capabilities: makeCapabilities(),
        availableModels: [
          { id: globalName, name: globalName },
          { id: userName, name: userName },
          { id: 'opencode-go/kimi-k3', name: 'Kimi K3' },
          { id: `e2e-local-${suffix}`, name: 'Local LLM' },
        ],
        currentModelId: globalName,
      });
      await openSessionPage(page, sessionId);

      await page.getByRole('button', { name: new RegExp(globalName) }).click();
      const groups = page.locator('[data-testid^="model-group-"]');
      // 四组固定顺序（DOM 顺序断言，非仅存在性）
      await expect(groups).toHaveCount(4);
      await expect(groups).toHaveText([
        /平台内置/,
        /Agent 自带/,
        /自定义/,
        /来源未知/,
      ]);
      // 组头含判定依据（去重后「；」连接）+ 组内归属（模型不得串组）
      await expect(page.getByTestId('model-group-平台内置')).toContainText('按平台模型库比对（平台内置）');
      await expect(page.getByTestId('model-group-平台内置')).toContainText(globalName);
      await expect(page.getByTestId('model-group-自定义')).toContainText('按平台模型库比对（自定义）');
      await expect(page.getByTestId('model-group-自定义')).toContainText(userName);
      await expect(page.getByTestId('model-group-Agent 自带')).toContainText('按标识前缀判定');
      await expect(page.getByTestId('model-group-Agent 自带')).toContainText('Kimi K3');
      await expect(page.getByTestId('model-group-来源未知')).toContainText('Local LLM');
      // 排除断言：组内归属不得串组
      await expect(page.getByTestId('model-group-平台内置')).not.toContainText('Kimi K3');
      await expect(page.getByTestId('model-group-Agent 自带')).not.toContainText(globalName);
      await expect(page.getByTestId('model-group-来源未知')).not.toContainText(globalName);

      disconnect();
    } finally {
      await collection.deleteMany({ name: { $in: [globalName, userName] } });
      await mongoose.disconnect();
    }
  });

  test('T-E37: 会话内问询提示条可打开弹窗', async ({ page }) => {
    const { socket, sessionId, disconnect } = await setupSession(page, { capabilities: makeCapabilities() });
    await openSessionPage(page, sessionId);

    socket.emit('acp:elicitation', {
      requestId: `e2e_cap_${Date.now()}`,
      sessionId,
      mode: 'form',
      message: 'Need your input',
      requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Answer' } } },
    });

    const banner = page.getByTestId('pending-elicitation-banner');
    await expect(banner).toBeVisible({ timeout: 25000 });

    // 桌面端全局待办可能已自动弹窗（遮罩会拦截提示条点击）：先关闭自动弹窗再验证兜底入口
    const dialog = page.getByRole('dialog');
    if (await dialog.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
    await banner.getByRole('button', { name: '查看' }).click();
    await expect(dialog.getByText('Need your input')).toBeVisible();

    disconnect();
  });

  test('T-E38: 问询超时后弹窗显示已过期且不可操作', async ({ page }) => {
    const { socket, sessionId, disconnect } = await setupSession(page, { capabilities: makeCapabilities() });
    await openSessionPage(page, sessionId);

    const requestId = `e2e_expired_${Date.now()}`;
    socket.emit('acp:elicitation', {
      requestId,
      sessionId,
      mode: 'form',
      message: 'Need your input',
      requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Answer' } } },
    });

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Need your input')).toBeVisible({ timeout: 25000 });

    socket.emit('acp:elicitation:resolved', { requestId, sessionId, reason: 'timeout' });

    // homeOverview 15s 轮询后弹窗收敛为「已过期」，操作按钮隐藏
    await expect(dialog.getByTestId('elicitation-status')).toContainText('该问询已过期', { timeout: 30000 });
    await expect(dialog.getByRole('button', { name: '提交' })).toHaveCount(0);

    disconnect();
  });

  test('T-E39: 移动端会话详情可打开问询弹窗', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { socket, sessionId, disconnect } = await setupSession(page, { capabilities: makeCapabilities() });
    await openSessionPage(page, sessionId);

    socket.emit('acp:elicitation', {
      requestId: `e2e_mobile_${Date.now()}`,
      sessionId,
      mode: 'form',
      message: 'Mobile input needed',
      requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Answer' } } },
    });

    const banner = page.getByTestId('pending-elicitation-banner');
    await expect(banner).toBeVisible({ timeout: 25000 });
    await banner.getByRole('button', { name: '查看' }).click();
    await expect(page.getByRole('dialog').getByText('Mobile input needed')).toBeVisible();

    disconnect();
  });

  test('T-E40: 初始模型应用失败 → 会话页 toast 提示「模式/模型设置未生效」', async ({ page }) => {
    const { socket, sessionId, disconnect } = await setupSession(page, {
      capabilities: makeCapabilities(),
      availableModels: [{ id: 'gpt-4o', name: 'GPT-4o' }],
      currentModelId: 'gpt-4o',
    });
    await openSessionPage(page, sessionId);

    // SSE 连接注册先于事件注入：短间隔重发直至 toast 出现（同文档重复写幂等，无副作用）。
    // 重发会产生多条相同文案的 toast，断言统一取 first()。
    const toast = page.getByText('模式/模型设置未生效：model unavailable').first();
    for (let i = 0; i < 5; i++) {
      socket.emit('acp:initial-config:result', {
        sessionId,
        modelId: 'gpt-4o',
        modelStatus: 'failed',
        error: 'model unavailable',
      });
      if (await toast.isVisible().catch(() => false)) break;
      await page.waitForTimeout(1000);
    }
    await expect(toast).toBeVisible({ timeout: 10000 });
    // toast 副行展示实际生效值，避免用户误以为所选模型已生效
    await expect(page.getByText('当前生效模型：GPT-4o').first()).toBeVisible();

    disconnect();
  });
});
