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
  const username = `ew${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
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
  `, { input: { name: `e2e-key-${Date.now()}`, type: 'local' } }, token);
  const body = await res.json();
  return { rawKey: body.data.createControllerKey.rawKey };
}

const FAKE_DIR_ENTRIES: Record<string, Array<{ name: string; path: string; isDirectory: boolean }>> = {
  '/home/user': [
    { name: 'Documents', path: '/home/user/Documents', isDirectory: true },
    { name: 'Projects', path: '/home/user/Projects', isDirectory: true },
    { name: 'Downloads', path: '/home/user/Downloads', isDirectory: true },
    { name: 'readme.txt', path: '/home/user/readme.txt', isDirectory: false },
  ],
  '/home/user/Projects': [
    { name: 'web-app', path: '/home/user/Projects/web-app', isDirectory: true },
    { name: 'cli-tool', path: '/home/user/Projects/cli-tool', isDirectory: true },
  ],
};

function registerController(rawKey: string): Promise<{ controllerId: string; disconnect: () => void }> {
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

    client.on('fs:browse', (data: { requestId: string; path: string | null }) => {
      const entries = (data.path && FAKE_DIR_ENTRIES[data.path]) || FAKE_DIR_ENTRIES['/home/user'] || [];
      client.emit('fs:browse:result', { requestId: data.requestId, entries });
    });

    client.on('fs:home', (data: { requestId: string }) => {
      client.emit('fs:home:result', { requestId: data.requestId, path: '/home/user' });
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
    client.emit('register', { key: rawKey, hostname: `e2e-ws-host-${Date.now()}`, version: '2.0.0' });
  });
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
}

async function goToSettings(page: import('@playwright/test').Page) {
  await page.click('a[href="/settings"]');
  await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
}

async function goToConfigPage(page: import('@playwright/test').Page) {
  await page.locator('#controller-section').getByRole('button', { name: '配置' }).first().click();
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible({ timeout: 5000 });
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

test.describe('Settings Workspace E2E', () => {

  test('should show config button for online controller', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await goToSettings(page);

    const section = page.locator('#controller-section');
    await expect(section.getByRole('button', { name: '配置' }).first()).toBeVisible({ timeout: 5000 });

    disconnect();
  });

  test('should navigate to config page with empty workspace state', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await goToSettings(page);
    await goToConfigPage(page);

    await expect(page.getByText('暂无工作区，点击「添加」开始配置')).toBeVisible();

    disconnect();
  });

  test('should add workspace via API and show on config page', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    await createWorkspace(page, controllerId, '/home/test/project', token);

    await loginViaUI(page, username);
    await goToSettings(page);
    await goToConfigPage(page);

    await expect(page.getByText('/home/test/project')).toBeVisible();

    disconnect();
  });

  test('should delete workspace from config page', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    await createWorkspace(page, controllerId, '/home/test/project-a', token);

    await loginViaUI(page, username);
    await goToSettings(page);
    await goToConfigPage(page);
    await expect(page.getByText('/home/test/project-a')).toBeVisible();

    await page.getByRole('button', { name: '删除' }).click();
    await expect(page.getByText('暂无工作区，点击「添加」开始配置')).toBeVisible();
    await expect(page.getByText('/home/test/project-a')).not.toBeVisible();

    disconnect();
  });

  test('should clear all workspaces', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    await createWorkspace(page, controllerId, '/home/test/project-a', token);
    await createWorkspace(page, controllerId, '/home/test/project-b', token);

    await loginViaUI(page, username);
    await goToSettings(page);
    await goToConfigPage(page);
    await expect(page.getByText('/home/test/project-a')).toBeVisible();
    await expect(page.getByText('/home/test/project-b')).toBeVisible();

    await page.getByRole('button', { name: '清空' }).click();
    await expect(page.getByText('确定要清空所有工作区吗？此操作不可撤销。')).toBeVisible();
    await page.getByRole('button', { name: '确认清空' }).click();

    await expect(page.getByText('暂无工作区，点击「添加」开始配置')).toBeVisible({ timeout: 5000 });

    disconnect();
  });

  test('should show DirectoryPicker UI and browse folders', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    await loginViaUI(page, username);
    await goToSettings(page);
    await goToConfigPage(page);
    await expect(page.getByText('暂无工作区，点击「添加」开始配置')).toBeVisible();

    await page.getByRole('button', { name: '添加' }).click();
    await expect(page.getByText('选择此目录')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: '取消' })).toBeVisible();
    await expect(page.getByRole('button', { name: '←', exact: true })).toBeDisabled();

    const browseRes = await gqlRequest(page, `
      query BrowseFolder($controllerId: ID!, $path: String) {
        browseFolder(controllerId: $controllerId, path: $path) {
          name path isDirectory
        }
      }
    `, { controllerId, path: '/home/user' }, token);
    const browseBody = await browseRes.json();
    expect(browseBody.data.browseFolder.length).toBeGreaterThan(0);
    const projects = browseBody.data.browseFolder.find((e: { name: string }) => e.name === 'Projects');
    expect(projects).toBeTruthy();

    const browseRes2 = await gqlRequest(page, `
      query BrowseFolder($controllerId: ID!, $path: String) {
        browseFolder(controllerId: $controllerId, path: $path) {
          name path isDirectory
        }
      }
    `, { controllerId, path: projects.path }, token);
    const browseBody2 = await browseRes2.json();
    const webApp = browseBody2.data.browseFolder.find((e: { name: string }) => e.name === 'web-app');
    expect(webApp).toBeTruthy();

    const wsRes = await gqlRequest(page, `
      mutation CreateWorkspace($input: CreateWorkspaceInput!) {
        createWorkspace(input: $input) { id name path }
      }
    `, { input: { controllerId, path: webApp.path } }, token);
    const wsBody = await wsRes.json();
    expect(wsBody.data.createWorkspace.path).toBe(webApp.path);

    await page.getByRole('button', { name: '取消' }).click();
    await page.reload();
    await goToSettings(page);
    await goToConfigPage(page);
    await expect(page.getByText(webApp.path)).toBeVisible({ timeout: 15000 });

    disconnect();
  });

  test('should show workspace selection in New Session dialog', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    await createWorkspace(page, controllerId, '/home/test/workspace-a', token);

    await loginViaUI(page, username);
    await page.goto('/sessions');
    await expect(page.getByRole('button', { name: '新建会话' })).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: '新建会话' }).click();
    await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();

    await page.locator('#controller').selectOption({ index: 1 });
    await expect(page.getByText('workspace-a', { exact: true }).first()).toBeVisible({ timeout: 5000 });
    // Open workspace select popup to verify path is listed
    await page.locator('[data-slot="select-trigger"]').nth(1).click();
    await expect(page.getByText('/home/test/workspace-a')).toBeVisible();

    disconnect();
  });

  test('should show sidebar tree with workspace and session', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);

    const ws = await createWorkspace(page, controllerId, '/home/test/myproject', token);
    const res = await gqlRequest(page, `
      mutation CreateSession($input: CreateSessionInput!) {
        createSession(input: $input) { session { id cwd status } }
      }
    `, {
      input: { controllerId, acpServerType: 'opencode', workspaceId: ws.id },
    }, token);
    const sessionBody = await res.json();
    expect(sessionBody.data.createSession.session.cwd).toBe('/home/test/myproject');

    await loginViaUI(page, username);

    const sidebar = page.locator('nav[aria-label="Sidebar"]');
    await expect(sidebar.getByRole('button', { name: /e2e-ws-host/ })).toBeVisible({ timeout: 5000 });

    await sidebar.getByRole('button', { name: /e2e-ws-host/ }).click();
    await expect(sidebar.getByText(/myproject/)).toBeVisible();

    disconnect();
  });

});
