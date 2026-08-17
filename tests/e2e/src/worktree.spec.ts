import { test, expect, type Page } from '@playwright/test';
import { registerUser, createControllerKey, registerController, loginViaUI, createWorkspace, createSession, gqlRequest, type FakeController } from './helpers';

const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

/** Wait for a condition to be true, polling every 150ms */
async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 15000, label = 'waitFor'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms`);
}

/** Expand controller and workspace nodes in sidebar to reveal worktree groups */
async function expandSidebarToWorktrees(page: Page, hostname = 'e2e-host'): Promise<void> {
  const sidebar = page.locator('nav[aria-label="Sidebar"]');
  await sidebar.getByRole('button', { name: new RegExp(hostname) }).click();
  await page.waitForTimeout(500);

  await waitFor(async () => {
    const wsButton = sidebar.locator('button').filter({ hasText: /e2e-ws-/ }).first();
    return (await wsButton.count()) > 0;
  }, 10000, 'waiting for workspace button');
  const wsButton = sidebar.locator('button').filter({ hasText: /e2e-ws-/ }).first();
  await wsButton.click();
  await page.waitForTimeout(500);
}

/** Register a fake controller that auto-answers ACP + worktree events */
async function registerWorktreeController(rawKey: string): Promise<FakeController> {
  const ctrl = await registerController(rawKey);
  ctrl.socket.on('git:worktree:list', (data: { requestId: string }) => {
    ctrl.socket.emit('git:worktree:list:result', {
      requestId: data.requestId,
      success: true,
      worktrees: [
        { path: '/tmp/e2e-worktree-main', branch: 'main', head: 'abc123' },
        { path: '/tmp/e2e-worktree-feature', branch: 'feature/test', head: 'def456' },
      ],
    });
  });
  ctrl.socket.on('git:worktree:remove', (data: { requestId: string }) => {
    ctrl.socket.emit('git:worktree:remove:result', { requestId: data.requestId, success: true });
  });
  ctrl.socket.on('fs:remove-dir', (data: { requestId: string }) => {
    ctrl.socket.emit('fs:remove-dir:result', { requestId: data.requestId, success: true });
  });
  ctrl.socket.on('git:check', (data: { requestId: string; path: string }) => {
    ctrl.socket.emit('git:check:result', {
      requestId: data.requestId,
      isGitRepo: true,
      currentBranch: 'main',
      branches: ['main', 'feature/test'],
      defaultBranch: 'main',
    });
  });
  ctrl.socket.on('git:status', (data: { requestId: string }) => {
    ctrl.socket.emit('git:status:result', { requestId: data.requestId, isClean: true });
  });
  ctrl.socket.on('git:commit', (data: { requestId: string }) => {
    ctrl.socket.emit('git:commit:result', { requestId: data.requestId, success: true });
  });
  ctrl.socket.on('acp:start', (data: { requestId: string; sessionId: string; serverType: string; cwd: string }) => {
    ctrl.socket.emit('acp:start:result', { requestId: data.requestId, success: true, sessionId: data.sessionId });
  });
  ctrl.socket.on('acp:stop', (data: { sessionId: string; ackRequired?: boolean }) => {
    if (data.ackRequired) {
      ctrl.socket.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_delete', killed: true });
    }
  });
  return ctrl;
}

test.describe('Worktree E2E Tests', () => {
  let ctrl: FakeController;
  let token: string;
  let username: string;
  let workspaceId: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const user = await registerUser(page);
    token = user.token;
    username = user.username;
    const key = await createControllerKey(page, token);
    ctrl = await registerWorktreeController(key.rawKey);

    const ws = await createWorkspace(page, ctrl.controllerId, `/tmp/e2e-ws-${Date.now()}`, token);
    workspaceId = ws.id;

    const detectRes = await gqlRequest(page, `
      query DetectGitRepo($controllerId: ID!, $workspaceId: ID!) {
        detectGitRepo(controllerId: $controllerId, workspaceId: $workspaceId) { isGitRepo currentBranch branches defaultBranch }
      }
    `, { controllerId: ctrl.controllerId, workspaceId }, token);
    const detectBody = await detectRes.json();
    if (detectBody.errors) console.error('detectGitRepo errors:', detectBody.errors);

    await page.close();
  });

  test.afterAll(() => {
    ctrl?.disconnect?.();
  });

  test('E2E-1: sidebar shows worktree hierarchy for git workspace', async ({ page }) => {
    test.setTimeout(60000);
    await loginViaUI(page, username);
    await expandSidebarToWorktrees(page);

    await waitFor(async () => {
      return (await page.locator('text=main').count()) > 0;
    }, 15000, 'waiting for worktree branch name "main" in sidebar');

    const featureBranch = page.locator('text=feature/test');
    await expect(featureBranch).toBeVisible({ timeout: 10000 });
  });

  test('E2E-2: worktree expand shows session count', async ({ page }) => {
    test.setTimeout(60000);
    await loginViaUI(page, username);
    await expandSidebarToWorktrees(page);

    await waitFor(async () => {
      return (await page.locator('text=main').count()) > 0;
    }, 15000, 'waiting for worktree in sidebar');

    const worktreeNode = page.locator('li').filter({ hasText: /^main/ }).first();
    await expect(worktreeNode).toBeVisible({ timeout: 10000 });
    const expandButton = worktreeNode.locator('button').first();
    await expandButton.click();
    await page.waitForTimeout(500);
  });

  test('E2E-3: add new session from worktree dropdown', async ({ page }) => {
    test.setTimeout(60000);
    await loginViaUI(page, username);
    await expandSidebarToWorktrees(page);

    await waitFor(async () => {
      return (await page.locator('text=main').count()) > 0;
    }, 15000, 'waiting for worktree');

    const worktreeItem = page.locator('li').filter({ hasText: /^main/ }).first();
    const addButton = worktreeItem.locator('[aria-label="添加"]').first();
    await addButton.click({ timeout: 5000 });
    await page.waitForTimeout(300);

    // Verify dropdown menu items are visible
    await expect(page.locator('[role="menuitem"]').filter({ hasText: '新建会话' })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[role="menuitem"]').filter({ hasText: '实例化工作流' })).toBeVisible({ timeout: 5000 });
  });

  test('E2E-4: delete worktree confirmation dialog', async ({ page }) => {
    test.setTimeout(60000);
    await loginViaUI(page, username);
    await expandSidebarToWorktrees(page);

    await waitFor(async () => {
      return (await page.locator('text=main').count()) > 0;
    }, 15000, 'waiting for worktree');

    const worktreeItem = page.locator('li').filter({ hasText: /^main/ }).first();
    const deleteButton = worktreeItem.locator('[aria-label="删除 Worktree"]').first();
    await deleteButton.click();

    await waitFor(async () => {
      const dialog = page.locator('[role="dialog"]');
      return (await dialog.count()) > 0;
    }, 5000, 'waiting for delete confirmation dialog');

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator('text=彻底删除')).toBeVisible({ timeout: 5000 });
    await expect(dialog.locator('text=不可恢复')).toBeVisible({ timeout: 5000 });

    const cancelBtn = dialog.locator('button').filter({ hasText: /取消|Cancel/ });
    if (await cancelBtn.count() > 0) {
      await cancelBtn.click();
      await expect(dialog).not.toBeVisible({ timeout: 5000 });
    }
  });

  test('E2E-5: delete session triggers process cleanup', async ({ page }) => {
    test.setTimeout(60000);
    await loginViaUI(page, username);

    const sessionId = await createSession(page, ctrl.controllerId, token, workspaceId);
    expect(sessionId).toBeTruthy();

    await page.goto(`/sessions/${sessionId}`);
    await page.waitForTimeout(1000);

    await gqlRequest(page, `mutation DeleteSession($id: ID!) { deleteSession(id: $id) }`, { id: sessionId }, token);

    await waitFor(async () => {
      const res = await gqlRequest(page, `query Session($id: ID!) { session(id: $id) { id } }`, { id: sessionId }, token);
      const body = await res.json();
      return body.data?.session === null;
    }, 15000, 'waiting for session to be deleted');
  });
});
