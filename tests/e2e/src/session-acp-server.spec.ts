import { test, expect } from '@playwright/test';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import { registerUser } from './helpers';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return page.request.post(API_URL, { headers, data: { query, variables } });
}

async function createControllerKey(page: import('@playwright/test').Page, token: string): Promise<{ rawKey: string }> {
  const res = await gqlRequest(page, `
    mutation CreateKey($input: CreateKeyInput!) {
      createControllerKey(input: $input) { rawKey key { id } }
    }
  `, { input: { name: `e2e-acp-key-${Date.now()}`, type: 'local' } }, token);
  const body = await res.json();
  return { rawKey: body.data.createControllerKey.rawKey };
}

function registerControllerWithMultiAcp(rawKey: string): Promise<{ controllerId: string; disconnect: () => void }> {
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
        servers: [
          { type: 'opencode', available: true, version: '1.0.0' },
          { type: 'github_copilot', available: true, version: '1.0.0' },
          { type: 'claude_code', available: true, version: '1.0.0' },
          { type: 'gemini_cli', available: true, version: '1.0.0' },
          { type: 'codex', available: true, version: '1.0.0' },
          { type: 'deepseek_harness', available: true, version: '0.1.2-alpha.2' },
        ],
      });
    });

    client.on('fs:mkdir', (data: { requestId: string }) => {
      client.emit('fs:mkdir:result', { requestId: data.requestId, success: true });
    });

    client.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      client.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_acp_${Date.now()}`,
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
    client.emit('register', { key: rawKey, hostname: `e2e-acp-host-${Date.now()}`, version: '2.0.0' });
  });
}

function registerControllerWithConfigOptions(rawKey: string): Promise<{ controllerId: string; disconnect: () => void; socket: ClientSocket }> {
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

    client.on('fs:mkdir', (data: { requestId: string }) => {
      client.emit('fs:mkdir:result', { requestId: data.requestId, success: true });
    });

    client.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      setTimeout(() => {
        client.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
          externalSessionId: `ext_cfg_${Date.now()}`,
          availableModels: [{ id: 'default', name: 'Default' }, { id: 'fast', name: 'Fast' }],
          currentModelId: 'default',
          configOptions: [
            { id: 'autosave', name: 'Autosave', type: 'boolean', currentValue: 'false', category: 'general' },
            { id: 'model', name: 'Model', type: 'select', currentValue: 'default', category: 'model', options: [{ value: 'default', name: 'Default' }, { value: 'fast', name: 'Fast' }] },
          ],
        });
      }, 300);
    });

    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve({ controllerId: data.controllerId, disconnect: () => client.disconnect(), socket: client });
    });
    client.once('error', (data: { code: string; message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Register failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname: `e2e-acp-cfg-host-${Date.now()}`, version: '2.0.0' });
  });
}

function registerControllerWithDelete(rawKey: string): Promise<{ controllerId: string; disconnect: () => void; waitForDelete: () => Promise<void> }> {
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

    client.on('acp:list-sessions', (data: { requestId: string; cwd: string }) => {
      client.emit('acp:list-sessions:result', {
        requestId: data.requestId,
        success: true,
        sessions: [
          { sessionId: 'e2e_del_sess_1', title: 'Delete Me Session', cwd: data.cwd, updatedAt: new Date().toISOString() },
        ],
      });
    });

    client.on('acp:load-session', (data: { requestId: string; sessionId: string; cwd: string }) => {
      client.emit('acp:load-session:result', {
        requestId: data.requestId,
        success: true,
        sessionId: data.sessionId,
        title: 'History - Delete Me',
        messages: [
          { direction: 'input', type: 'text', content: JSON.stringify({ text: 'hi' }) },
          { direction: 'output', type: 'text', content: JSON.stringify({ text: 'hello' }) },
        ],
      });
    });

    let deleteResolve: (() => void) | null = null;
    const deletePromise = new Promise<void>((resolveDelete) => {
      deleteResolve = resolveDelete;
    });
    client.on('acp:delete-history-session', (data: { requestId: string; sessionId: string }) => {
      client.emit('acp:delete-history-session:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        supported: true,
      });
      deleteResolve?.();
    });

    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve({ controllerId: data.controllerId, disconnect: () => client.disconnect(), waitForDelete: () => deletePromise });
    });
    client.once('error', (data: { code: string; message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Register failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname: `e2e-acp-del-host-${Date.now()}`, version: '2.0.0' });
  });
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
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

test.describe('Session ACP Server Type', () => {

  test('should show ACP Server selector after selecting controller', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerControllerWithMultiAcp(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-acp-${Math.random().toString(36).slice(2, 8)}`, token);

    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.locator('main').getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });
    await page.locator('main').getByRole('button', { name: '新建会话' }).click();
    await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();

    await page.locator('#controller').selectOption({ index: 1 });

    // ACP Server section should appear and loading should complete
    await expect(page.getByText('检测 ACP 服务中...')).not.toBeVisible({ timeout: 10000 });
    const acpTrigger = page.locator('[role="combobox"]').first();
    await expect(acpTrigger).toBeVisible({ timeout: 10000 });

    // Click to open dropdown and verify all options
    await acpTrigger.click();
    await expect(page.getByRole('option', { name: /opencode/ })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('option', { name: /github_copilot/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /claude_code/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /gemini_cli/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /codex/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /deepseek_harness/ })).toBeVisible();

    disconnect();
  });

  test('should create session with github_copilot and show badge', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerControllerWithMultiAcp(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-acp-gc-${Math.random().toString(36).slice(2, 8)}`, token);

    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.locator('main').getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });
    await page.locator('main').getByRole('button', { name: '新建会话' }).click();
    await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();

    await page.locator('#controller').selectOption({ index: 1 });

    // Wait for ACP Server loading to complete
    await expect(page.getByText('检测 ACP 服务中...')).not.toBeVisible({ timeout: 10000 });
    const acpTrigger = page.locator('[role="combobox"]').first();
    await expect(acpTrigger).toBeVisible({ timeout: 5000 });
    await acpTrigger.click();
    await page.getByRole('option', { name: /github_copilot/ }).click();
    await expect(acpTrigger).toContainText('github_copilot', { timeout: 5000 });

    // Create Session should now be enabled
    await expect(page.getByRole('button', { name: '创建会话' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: '创建会话' }).click();

    // Should navigate to session detail
    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 15000 });

    // Verify GitHub Copilot badge is visible
    await expect(page.getByText('GitHub Copilot')).toBeVisible({ timeout: 10000 });

    disconnect();
  });

  test('should create session with opencode and show OpenCode badge', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerControllerWithMultiAcp(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-acp-oc-${Math.random().toString(36).slice(2, 8)}`, token);

    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.locator('main').getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });
    await page.locator('main').getByRole('button', { name: '新建会话' }).click();
    await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();

    await page.locator('#controller').selectOption({ index: 1 });

    // Wait for ACP Server loading to complete - opencode is auto-selected
    await expect(page.getByText('检测 ACP 服务中...')).not.toBeVisible({ timeout: 10000 });

    // Create Session should be enabled with auto-selected opencode
    await expect(page.getByRole('button', { name: '创建会话' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: '创建会话' }).click();

    // Should navigate to session detail
    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 15000 });

    // Verify OpenCode badge is visible
    await expect(page.getByText('OpenCode')).toBeVisible({ timeout: 10000 });

    disconnect();
  });

  test('should create session with deepseek_harness and show DeepSeek Harness badge', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerControllerWithMultiAcp(rawKey);
    await createWorkspace(page, controllerId, `/tmp/e2e-acp-dsh-${Math.random().toString(36).slice(2, 8)}`, token);

    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.locator('main').getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });
    await page.locator('main').getByRole('button', { name: '新建会话' }).click();
    await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();

    await page.locator('#controller').selectOption({ index: 1 });

    await expect(page.getByText('检测 ACP 服务中...')).not.toBeVisible({ timeout: 10000 });
    const acpTrigger = page.locator('[role="combobox"]').first();
    await expect(acpTrigger).toBeVisible({ timeout: 5000 });
    await acpTrigger.click();
    await page.getByRole('option', { name: /deepseek_harness/ }).click();
    await expect(acpTrigger).toContainText('deepseek_harness', { timeout: 5000 });

    await expect(page.getByRole('button', { name: '创建会话' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: '创建会话' }).click();

    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 15000 });
    await expect(page.getByText('DeepSeek Harness')).toBeVisible({ timeout: 10000 });
    // 无登录引导：DeepSeek Harness 走平台渠道注入，不应出现任何登录弹窗
    await expect(page.getByRole('dialog')).toHaveCount(0);

    disconnect();
  });

  test('should create session with claude_code and show Claude Code badge', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerControllerWithMultiAcp(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-acp-cc-${Math.random().toString(36).slice(2, 8)}`, token);

    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.locator('main').getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });
    await page.locator('main').getByRole('button', { name: '新建会话' }).click();
    await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();

    await page.locator('#controller').selectOption({ index: 1 });

    // Wait for ACP Server loading to complete
    await expect(page.getByText('检测 ACP 服务中...')).not.toBeVisible({ timeout: 10000 });
    const acpTrigger = page.locator('[role="combobox"]').first();
    await expect(acpTrigger).toBeVisible({ timeout: 5000 });
    await acpTrigger.click();
    await page.getByRole('option', { name: /claude_code/ }).click();
    await expect(acpTrigger).toContainText('claude_code', { timeout: 5000 });

    // Create Session should now be enabled
    await expect(page.getByRole('button', { name: '创建会话' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: '创建会话' }).click();

    // Should navigate to session detail
    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 15000 });

    // Verify Claude Code badge is visible
    await expect(page.getByText('Claude Code')).toBeVisible({ timeout: 10000 });

    disconnect();
  });

  test('should create session with gemini_cli and show Gemini CLI badge', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerControllerWithMultiAcp(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-acp-gc-${Math.random().toString(36).slice(2, 8)}`, token);

    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.locator('main').getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });
    await page.locator('main').getByRole('button', { name: '新建会话' }).click();
    await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();

    await page.locator('#controller').selectOption({ index: 1 });

    // Wait for ACP Server loading to complete
    await expect(page.getByText('检测 ACP 服务中...')).not.toBeVisible({ timeout: 10000 });
    const acpTrigger = page.locator('[role="combobox"]').first();
    await expect(acpTrigger).toBeVisible({ timeout: 5000 });
    await acpTrigger.click();
    await page.getByRole('option', { name: /gemini_cli/ }).click();
    await expect(acpTrigger).toContainText('gemini_cli', { timeout: 5000 });

    // Create Session should now be enabled
    await expect(page.getByRole('button', { name: '创建会话' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: '创建会话' }).click();

    // Should navigate to session detail
    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 15000 });

    // Verify Gemini CLI badge is visible
    await expect(page.getByText('Gemini CLI')).toBeVisible({ timeout: 10000 });

    disconnect();
  });

  test('should create session with codex and show Codex badge', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerControllerWithMultiAcp(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-acp-cx-${Math.random().toString(36).slice(2, 8)}`, token);

    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.locator('main').getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });
    await page.locator('main').getByRole('button', { name: '新建会话' }).click();
    await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();

    await page.locator('#controller').selectOption({ index: 1 });

    // Wait for ACP Server loading to complete
    await expect(page.getByText('检测 ACP 服务中...')).not.toBeVisible({ timeout: 10000 });
    const acpTrigger = page.locator('[role="combobox"]').first();
    await expect(acpTrigger).toBeVisible({ timeout: 5000 });
    await acpTrigger.click();
    await page.getByRole('option', { name: /codex/ }).click();
    await expect(acpTrigger).toContainText('codex', { timeout: 5000 });

    // Create Session should now be enabled
    await expect(page.getByRole('button', { name: '创建会话' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: '创建会话' }).click();

    // Should navigate to session detail
    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 15000 });

    // Verify Codex badge is visible
    await expect(page.getByText('Codex')).toBeVisible({ timeout: 10000 });

    disconnect();
  });

  test('should render config options panel with boolean switch and forward changes to controller', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, socket } = await registerControllerWithConfigOptions(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-acp-cfg-${Math.random().toString(36).slice(2, 8)}`, token);

    const setConfigPromise = new Promise<{ sessionId: string; configId: string; value: string }>((resolve) => {
      socket.on('acp:set-config-option', (data: { sessionId: string; configId: string; value: string }) => {
        socket.emit('acp:set-config-option:result', {
          sessionId: data.sessionId,
          configId: data.configId,
          value: data.value,
          success: true,
        });
        resolve(data);
      });
    });

    const setModelPromise = new Promise<{ sessionId: string; modelId: string }>((resolve) => {
      socket.on('acp:set-model', (data: { sessionId: string; modelId: string }) => {
        resolve(data);
      });
    });

    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.locator('main').getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });
    await page.locator('main').getByRole('button', { name: '新建会话' }).click();
    await page.locator('#controller').selectOption({ index: 1 });

    await expect(page.getByText('检测 ACP 服务中...')).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: '创建会话' })).toBeEnabled({ timeout: 10000 });
    await page.getByRole('button', { name: '创建会话' }).click();

    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 15000 });
    await expect(page.getByTestId('session-status-badge')).toHaveText('空闲', { timeout: 10000 });

    // Config options panel renders the boolean switch (category=mode/model 由 ModeSwitcher/ModelSwitcher 负责，不在面板中)
    const switchBtn = page.getByRole('switch', { name: 'Autosave' });
    await expect(switchBtn).toBeVisible({ timeout: 10000 });
    await expect(switchBtn).toBeEnabled();

    // Toggle the switch → controller receives acp:set-config-option (category=general 走配置项通道)
    await switchBtn.click();
    const setConfigData = await setConfigPromise;
    expect(setConfigData.configId).toBe('autosave');
    expect(setConfigData.value).toBe('true');

    // Switch model via ModelSwitcher → controller receives acp:set-model
    // (category=model 双轨路由；bridge 内部再转到 setSessionConfigOption，由 acp-bridge 单测覆盖)
    await page.getByRole('button', { name: 'Default' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Fast' }).click();
    const setModelData = await setModelPromise;
    expect(setModelData.modelId).toBe('fast');

    disconnect();
  });

  test('should delete imported history session and sync to agent', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect, waitForDelete } = await registerControllerWithDelete(rawKey);
    await createWorkspace(page, controllerId, `/tmp/e2e-del-${Math.random().toString(36).slice(2, 8)}`, token);

    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.locator('main').getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });

    // Import the history session via settings
    await page.goto('/settings');
    await page.locator('#controller-section').getByRole('button', { name: '配置' }).first().click();
    await expect(page).toHaveURL(/settings\?controllerId=/);
    await page.getByRole('button', { name: '历史会话' }).click();
    await expect(page.getByText('Delete Me Session')).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: '全选' }).click();
    await page.getByRole('button', { name: '导入已选 (1)' }).click();
    await expect(page.getByText('成功导入 1 个会话')).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: '完成' }).click();

    // Open the imported session from the sidebar sessions list（控制器默认展开，勿点击折叠）
    await page.goto('/sessions');
    const sidebar = page.locator('nav[aria-label="Sidebar"]');
    const historyLink = sidebar.getByRole('link', { name: 'History - Delete Me', exact: true });
    await expect(historyLink).toBeVisible({ timeout: 10000 });
    await historyLink.click();

    await expect(page).toHaveURL(/\/sessions\/[a-f0-9]+/, { timeout: 15000 });

    // Delete the imported history session → syncs to agent
    await page.getByRole('button', { name: '删除' }).click();

    await waitForDelete();
    await expect(page).toHaveURL(/\/sessions$/, { timeout: 10000 });

    // Session removed from list（Sidebar 由 15s 轮询刷新，给下一次聚合查询留出时间）
    await expect(page.getByRole('link', { name: /History - Delete Me/ })).toHaveCount(0, {
      timeout: 20000,
    });

    disconnect();
  });

});
