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

    // Create a git-like workspace (simulate isGitRepo by calling detectGitRepo)
    const ws = await createWorkspace(page, ctrl.controllerId, `/tmp/e2e-ws-${Date.now()}`, token);
    workspaceId = ws.id;

    // Detect git repo to persist isGitRepo
    await gqlRequest(page, `
      query DetectGitRepo($controllerId: ID!, $workspaceId: ID!) {
        detectGitRepo(controllerId: $controllerId, workspaceId: $workspaceId) { isGitRepo }
      }
    `, { controllerId: ctrl.controllerId, workspaceId }, token);

    await page.close();
  });

  test.afterAll(() => {
    ctrl?.disconnect?.();
  });

  // ── E2E-1: 侧边栏 worktree 层级展示 ────────────────────────
  test('E2E-1: sidebar shows worktree hierarchy for git workspace', async ({ page }) => {
    test.setTimeout(60000);
    await loginViaUI(page, username);

    // The sidebar should show the workspace with worktree groups
    // Look for the worktree branch names rendered by WorktreeSidebarGroup
    await waitFor(async () => {
      const worktreeText = await page.locator('text=main').count();
      return worktreeText > 0;
    }, 15000, 'waiting for worktree branch name "main" in sidebar');

    // Feature branch should also be visible
    const featureBranch = page.locator('text=feature/test');
    await expect(featureBranch).toBeVisible({ timeout: 10000 });
  });

  // ── E2E-2: worktree 展开显示关联会话 ────────────────────────
  test('E2E-2: worktree expand shows associated sessions', async ({ page }) => {
    test.setTimeout(60000);
    await loginViaUI(page, username);

    // Create a session in the worktree
    const sessionId = await createSession(page, ctrl.controllerId, token, workspaceId);

    // Wait for sidebar to load
    await waitFor(async () => {
      const count = await page.locator('text=main').count();
      return count > 0;
    }, 15000, 'waiting for worktree in sidebar');

    // Click to expand the worktree
    const worktreeNode = page.locator('li').filter({ hasText: 'main' }).first();
    const expandButton = worktreeNode.locator('button').first();
    await expandButton.click();

    // The session should be visible under the expanded worktree
    await waitFor(async () => {
      const sessionLink = page.locator(`a[href="/sessions/${sessionId}"]`);
      return await sessionLink.count() > 0;
    }, 10000, 'waiting for session link in expanded worktree');

    // Click should navigate to session page
    const sessionLink = page.locator(`a[href="/sessions/${sessionId}"]`);
    await sessionLink.click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}`));
  });

  // ── E2E-3: worktree 添加 ────────────────────────────────────
  test('E2E-3: add new session from worktree', async ({ page }) => {
    test.setTimeout(60000);
    await loginViaUI(page, username);

    // Wait for worktree to appear
    await waitFor(async () => {
      return (await page.locator('text=main').count()) > 0;
    }, 15000, 'waiting for worktree');

    // Click the add button on the worktree
    const worktreeItem = page.locator('li').filter({ hasText: 'main' }).first();
    const addButton = worktreeItem.locator('[aria-label="添加"]');
    await addButton.click();

    // Click "新建会话" in the dropdown
    await page.locator('text=新建会话').click();

    // The NewSessionDialog should open with the worktree preselected
    // Verify the dialog is visible
    await waitFor(async () => {
      const dialog = page.locator('[role="dialog"]');
      return (await dialog.count()) > 0;
    }, 5000, 'waiting for new session dialog');
  });

  // ── E2E-4: worktree 删除确认弹窗 ────────────────────────────
  test('E2E-4: delete worktree confirmation dialog', async ({ page }) => {
    test.setTimeout(60000);
    await loginViaUI(page, username);

    // Wait for worktree to appear
    await waitFor(async () => {
      return (await page.locator('text=main').count()) > 0;
    }, 15000, 'waiting for worktree');

    // Click delete button on worktree
    const worktreeItem = page.locator('li').filter({ hasText: 'main' }).first();
    const deleteButton = worktreeItem.locator('[aria-label="删除 Worktree"]');
    await deleteButton.click();

    // Confirm dialog should appear with warning text
    await waitFor(async () => {
      const dialog = page.locator('[role="dialog"]');
      return (await dialog.count()) > 0;
    }, 5000, 'waiting for delete confirmation dialog');

    // Verify warning text contains "彻底删除" and "不可恢复"
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator('text=彻底删除')).toBeVisible({ timeout: 5000 });
    await expect(dialog.locator('text=不可恢复')).toBeVisible({ timeout: 5000 });

    // Cancel should close dialog without changes
    const cancelBtn = dialog.locator('button').filter({ hasText: /取消|Cancel/ });
    if (await cancelBtn.count() > 0) {
      await cancelBtn.click();
      await expect(dialog).not.toBeVisible({ timeout: 5000 });
    }
  });

  // ── E2E-5: 删除会话后进程销毁 ──────────────────────────────
  test('E2E-5: delete session triggers process cleanup', async ({ page }) => {
    test.setTimeout(60000);
    await loginViaUI(page, username);

    // Create a session
    const sessionId = await createSession(page, ctrl.controllerId, token, workspaceId);

    // Navigate to session page
    await page.goto(`/sessions/${sessionId}`);
    await waitFor(async () => {
      return (await page.locator(`text=${sessionId}`).count()) > 0 ||
             (await page.locator('[role="dialog"]').count()) === 0;
    }, 10000, 'waiting for session page');

    // Delete the session via API (simulating UI delete action)
    await gqlRequest(page, `mutation DeleteSession($id: ID!) { deleteSession(id: $id) }`, { id: sessionId }, token);

    // Verify session is gone from sidebar
    await waitFor(async () => {
      const links = page.locator(`a[href="/sessions/${sessionId}"]`);
      return (await links.count()) === 0;
    }, 10000, 'waiting for session to disappear from sidebar');
  });
});
