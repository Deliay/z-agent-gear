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
  const username = `eg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
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
  `, { input: { name: `e2e-git-key-${Date.now()}`, type: 'local' } }, token);
  const body = await res.json();
  return { rawKey: body.data.createControllerKey.rawKey };
}

interface GitCheckOptions {
  isGitRepo: boolean;
  currentBranch?: string;
  branches?: string[];
  defaultBranch?: string;
}

function registerController(
  rawKey: string,
  gitCheckResponse?: () => GitCheckOptions,
  gitInitResponse?: () => { success: boolean; error?: string },
): Promise<{ controllerId: string; disconnect: () => void }> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'], reconnection: false, forceNew: true,
    });
    const timer = setTimeout(() => { client.disconnect(); reject(new Error('Timeout registering controller')); }, 10000);

    client.on('acp:check', (data: { requestId: string }) => {
      client.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      });
    });

    client.on('fs:browse', (data: { requestId: string; path: string | null }) => {
      client.emit('fs:browse:result', { requestId: data.requestId, entries: [] });
    });

    client.on('fs:home', (data: { requestId: string }) => {
      client.emit('fs:home:result', { requestId: data.requestId, path: '/home/user' });
    });

    client.on('git:check', (data: { requestId: string; path: string }) => {
      const resp = gitCheckResponse ? gitCheckResponse() : { isGitRepo: false };
      client.emit('git:check:result', { requestId: data.requestId, success: true, ...resp });
    });

    client.on('git:init', (data: { requestId: string; path: string }) => {
      const resp = gitInitResponse ? gitInitResponse() : { success: true };
      client.emit('git:init:result', { requestId: data.requestId, ...resp });
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
    client.emit('register', { key: rawKey, hostname: `e2e-git-host-${Date.now()}`, version: '1.0.0' });
  });
}

async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
}

async function goToConfigPage(page: import('@playwright/test').Page) {
  await page.click('a[href="/settings"]');
  await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
  await page.locator('#controller-section').getByRole('button', { name: '配置' }).first().click();
  await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible({ timeout: 5000 });
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

async function expandWorkspace(page: import('@playwright/test').Page, path: string) {
  const card = page.locator('li.rounded-lg').filter({ hasText: path }).first();
  const expandBtn = card.locator('button[type="button"]').filter({ has: page.locator('svg') }).first();
  await expandBtn.click();
}

test.describe('Settings Workspace Git E2E', () => {
  test('should show non-git directory message when workspace expanded on non-repo', async ({ page }) => {
    test.setTimeout(60000);
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);

    let gitIsRepo = false;
    const { controllerId, disconnect } = await registerController(
      rawKey,
      () => ({ isGitRepo: gitIsRepo }),
    );

    const wsPath = `/home/user/non-repo-${Date.now()}`;
    await createWorkspace(page, controllerId, wsPath, token);

    await loginViaUI(page, username);
    await goToConfigPage(page);
    await expect(page.getByText(wsPath)).toBeVisible({ timeout: 5000 });

    await expandWorkspace(page, wsPath);

    await expect(page.getByText('该目录不是 Git 仓库')).toBeVisible({ timeout: 35000 });
    await expect(page.getByRole('button', { name: '初始化 Git 仓库' })).toBeVisible();

    disconnect();
  });

  test('should show git branch info when workspace expanded on a git repo', async ({ page }) => {
    test.setTimeout(60000);
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);

    const { controllerId, disconnect } = await registerController(
      rawKey,
      () => ({
        isGitRepo: true,
        currentBranch: 'main',
        branches: ['main', 'develop', 'feature/test'],
        defaultBranch: 'main',
      }),
    );

    const wsPath = `/home/user/git-repo-${Date.now()}`;
    await createWorkspace(page, controllerId, wsPath, token);

    await loginViaUI(page, username);
    await goToConfigPage(page);
    await expect(page.getByText(wsPath)).toBeVisible({ timeout: 5000 });

    await expandWorkspace(page, wsPath);

    await expect(page.getByText('当前分支:')).toBeVisible({ timeout: 35000 });
    await expect(page.getByText('main').first()).toBeVisible();
    await expect(page.getByText('默认分支')).toBeVisible();

    const selectTrigger = page.locator('[data-slot="select-trigger"]');
    await selectTrigger.click();
    await expect(page.locator('[data-slot="select-popup"]')).toBeVisible();
    await expect(page.getByRole('option', { name: 'develop' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'feature/test' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'main' })).toBeVisible();
    await page.locator('[data-slot="select-popup"]').press('Escape');

    disconnect();
  });

  test('should initialize git repo and transition to git state', async ({ page }) => {
    test.setTimeout(90000);
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);

    let gitIsRepo = false;
    const { controllerId, disconnect } = await registerController(
      rawKey,
      () => ({
        isGitRepo: gitIsRepo,
        ...(gitIsRepo ? { currentBranch: 'main', branches: ['main'], defaultBranch: 'main' } : {}),
      }),
      () => {
        gitIsRepo = true;
        return { success: true };
      },
    );

    const wsPath = `/home/user/to-init-${Date.now()}`;
    await createWorkspace(page, controllerId, wsPath, token);

    await loginViaUI(page, username);
    await goToConfigPage(page);
    await expect(page.getByText(wsPath)).toBeVisible({ timeout: 5000 });

    await expandWorkspace(page, wsPath);
    await expect(page.getByText('该目录不是 Git 仓库')).toBeVisible({ timeout: 35000 });

    await page.getByRole('button', { name: '初始化 Git 仓库' }).click();

    await expect(page.getByText('当前分支:')).toBeVisible({ timeout: 45000 });
    await expect(page.getByText('main').first()).toBeVisible();

    disconnect();
  });

  test('should set default branch from dropdown', async ({ page }) => {
    test.setTimeout(60000);
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);

    const { controllerId, disconnect } = await registerController(
      rawKey,
      () => ({
        isGitRepo: true,
        currentBranch: 'develop',
        branches: ['main', 'develop', 'feature/test'],
        defaultBranch: 'main',
      }),
    );

    const wsPath = `/home/user/set-default-${Date.now()}`;
    const ws = await createWorkspace(page, controllerId, wsPath, token);

    await loginViaUI(page, username);
    await goToConfigPage(page);
    await expect(page.getByText(wsPath)).toBeVisible({ timeout: 5000 });

    await expandWorkspace(page, wsPath);
    await expect(page.getByText('当前分支:')).toBeVisible({ timeout: 35000 });

    const selectTrigger = page.locator('[data-slot="select-trigger"]');
    await selectTrigger.click();
    await expect(page.locator('[data-slot="select-popup"]')).toBeVisible();

    await page.getByRole('option', { name: 'develop' }).click();

    await expect(selectTrigger).toHaveText('develop', { timeout: 5000 });

    const verifyRes = await gqlRequest(page, `
      query ControllerWorkspaces($controllerId: ID!) {
        controllerWorkspaces(controllerId: $controllerId) { id defaultBranch }
      }
    `, { controllerId }, token);
    const verifyBody = await verifyRes.json();
    const updated = verifyBody.data.controllerWorkspaces.find((w: { id: string }) => w.id === ws.id);
    expect(updated.defaultBranch).toBe('develop');

    disconnect();
  });

  test('should show all branches in dropdown', async ({ page }) => {
    test.setTimeout(60000);
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);

    const { controllerId, disconnect } = await registerController(
      rawKey,
      () => ({
        isGitRepo: true,
        currentBranch: 'main',
        branches: ['main', 'develop', 'feature/test', 'feat/other', 'fix/bug'],
        defaultBranch: 'main',
      }),
    );

    const wsPath = `/home/user/all-branches-${Date.now()}`;
    await createWorkspace(page, controllerId, wsPath, token);

    await loginViaUI(page, username);
    await goToConfigPage(page);
    await expect(page.getByText(wsPath)).toBeVisible({ timeout: 5000 });

    await expandWorkspace(page, wsPath);
    await expect(page.getByText('当前分支:')).toBeVisible({ timeout: 35000 });

    const selectTrigger = page.locator('[data-slot="select-trigger"]');
    await selectTrigger.click();
    await expect(page.locator('[data-slot="select-popup"]')).toBeVisible();

    await expect(page.getByRole('option', { name: 'main' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'develop' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'feature/test' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'feat/other' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'fix/bug' })).toBeVisible();

    disconnect();
  });
});
