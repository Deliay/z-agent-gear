import { test, expect, type Page } from '@playwright/test';
import { registerUser, createControllerKey, registerController, loginViaUI, createWorkspace, createSession, gqlRequest, type FakeController } from './helpers';

const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

/** fake controller 上报的 worktree 路径（须在 workspace 的 worktreeDir scope 内，否则 existingWorktreePath 归属校验拒绝） */
let mainWorktreePath = '';
let featureWorktreePath = '';
/** fake controller 收到的 acp:stop 会话 ID 记录（事件到达断言用） */
const stoppedSessionIds: string[] = [];

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
        { path: mainWorktreePath, branch: 'main', head: 'abc123' },
        { path: featureWorktreePath, branch: 'feature/test', head: 'def456' },
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
    stoppedSessionIds.push(data.sessionId);
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

    const wsPath = `/tmp/e2e-ws-${Date.now()}`;
    const ws = await createWorkspace(page, ctrl.controllerId, wsPath, token);
    workspaceId = ws.id;
    // worktree 路径须归属该 workspace 的 worktreeDir scope（与 A3/A6 API 测试一致）。
    // 校验端会用控制器上报的 homeDir（helpers.ts 中 /home/fake）将 ~ 展开为绝对路径，故此处用展开后的绝对路径。
    const wsName = wsPath.split('/').filter(Boolean).pop()!;
    mainWorktreePath = `/home/fake/.zag/worktrees/${wsName}/main`;
    featureWorktreePath = `/home/fake/.zag/worktrees/${wsName}/feature-test`;

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

  test('E2E-2: worktree expand shows grouped sessions', async ({ page }) => {
    test.setTimeout(90000);
    // 通过 API 在 main worktree 下创建会话（existingWorktreePath 复用归组）
    const createRes = await gqlRequest(page, `
      mutation CreateSession($input: CreateSessionInput!) {
        createSession(input: $input) { session { id worktreePath } }
      }
    `, { input: { controllerId: ctrl.controllerId, acpServerType: 'opencode', workspaceId, existingWorktreePath: mainWorktreePath } }, token);
    const createBody = await createRes.json();
    expect(createBody.errors).toBeUndefined();
    const sessionId = createBody.data.createSession.session.id as string;
    expect(createBody.data.createSession.session.worktreePath).toBe(mainWorktreePath);

    await loginViaUI(page, username);
    await expandSidebarToWorktrees(page);

    await waitFor(async () => {
      return (await page.locator('text=main').count()) > 0;
    }, 15000, 'waiting for worktree in sidebar');

    // 展开 main 分组 → 显示归属该 worktree 的会话（可点击跳转会话页）与会话计数
    const worktreeNode = page.locator('li').filter({ hasText: /^main/ }).first();
    await expect(worktreeNode).toBeVisible({ timeout: 10000 });
    await worktreeNode.locator('button').first().click();

    await waitFor(async () => {
      return (await page.locator(`a[href="/sessions/${sessionId}"]`).count()) > 0;
    }, 20000, 'waiting for grouped session link under worktree');
    await expect(worktreeNode.locator(`a[href="/sessions/${sessionId}"]`)).toBeVisible();
    await expect(worktreeNode.locator('button').first()).toContainText('1');

    // 点击会话链接可跳转会话页
    await worktreeNode.locator(`a[href="/sessions/${sessionId}"]`).click();
    await page.waitForURL(`/sessions/${sessionId}`, { timeout: 10000 });
  });

  test('E2E-3: create session from worktree dropdown lands in the group', async ({ page }) => {
    test.setTimeout(90000);
    await loginViaUI(page, username);
    await expandSidebarToWorktrees(page);

    await waitFor(async () => {
      return (await page.locator('text=main').count()) > 0;
    }, 15000, 'waiting for worktree');

    // 在 main 分组上通过「添加 → 新建会话」发起创建
    const mainRow = page.getByRole('button', { name: /^main/ }).locator('..');
    await mainRow.locator('[aria-label="添加"]').click({ timeout: 5000 });
    await page.locator('[role="menuitem"]').filter({ hasText: '新建会话' }).click();

    // 预选择模式：对话框展示目标 worktree 路径
    await expect(page.getByText('Worktree 路径')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(mainWorktreePath)).toBeVisible();
    // 等待 ACP 服务检测完成（opencode 自动选中）
    await expect(page.getByText('检测 ACP 服务中...')).not.toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: '创建会话' }).click();

    // 创建后跳转会话详情页
    await page.waitForURL(/\/sessions\/[a-z0-9]+/i, { timeout: 15000 });
    const sessionId = page.url().split('/sessions/')[1];
    expect(sessionId).toBeTruthy();

    // 新会话归属该 worktree（API 校验 worktreePath）
    await waitFor(async () => {
      const res = await gqlRequest(page, `query Session($id: ID!) { session(id: $id) { id worktreePath } }`, { id: sessionId }, token);
      const body = await res.json();
      return body.data?.session?.worktreePath === mainWorktreePath;
    }, 10000, 'waiting for session worktreePath to equal worktree');

    // 归组展示：回到首页展开 main 分组可见新会话
    await page.goto('/');
    await expandSidebarToWorktrees(page);
    const worktreeNode = page.locator('li').filter({ hasText: /^main/ }).first();
    await expect(worktreeNode).toBeVisible({ timeout: 10000 });
    await worktreeNode.locator('button').first().click();
    await waitFor(async () => {
      return (await page.locator(`a[href="/sessions/${sessionId}"]`).count()) > 0;
    }, 20000, 'waiting for new session grouped under worktree');
  });

  test('E2E-4: delete worktree via confirmation dialog', async ({ page }) => {
    test.setTimeout(90000);
    // 先通过 API 在 feature worktree 下创建会话（确认删除后应被清理）
    const createRes = await gqlRequest(page, `
      mutation CreateSession($input: CreateSessionInput!) {
        createSession(input: $input) { session { id worktreePath } }
      }
    `, { input: { controllerId: ctrl.controllerId, acpServerType: 'opencode', workspaceId, existingWorktreePath: featureWorktreePath } }, token);
    const createBody = await createRes.json();
    expect(createBody.errors).toBeUndefined();
    const sessionId = createBody.data.createSession.session.id as string;

    await loginViaUI(page, username);
    await expandSidebarToWorktrees(page);

    await waitFor(async () => {
      return (await page.locator('text=feature/test').count()) > 0;
    }, 15000, 'waiting for feature worktree');

    const featureRow = page.getByRole('button', { name: /feature\/test/ }).locator('..');
    await featureRow.locator('[aria-label="删除 Worktree"]').click();

    // 确认对话框：文案含「彻底删除」「不可恢复」与关联会话数量
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.locator('text=彻底删除')).toBeVisible({ timeout: 5000 });
    await expect(dialog.locator('text=不可恢复')).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByText(/关联了 \d+ 个会话/)).toBeVisible({ timeout: 5000 });

    // 走确认删除路径
    await dialog.getByRole('button', { name: '确认删除' }).click();

    // 删除成功提示
    await expect(page.getByText('Worktree 已删除')).toBeVisible({ timeout: 30000 });

    // 关联会话被清理（DB 删除 + fake controller 收到 acp:stop）
    await waitFor(async () => {
      const res = await gqlRequest(page, `query Session($id: ID!) { session(id: $id) { id } }`, { id: sessionId }, token);
      const body = await res.json();
      return body.data?.session === null;
    }, 15000, 'waiting for worktree session cleanup');
    await waitFor(() => stoppedSessionIds.includes(sessionId), 10000, 'waiting for acp:stop of worktree session');

    // worktree 分组不再有关联会话（API 校验）
    await waitFor(async () => {
      const res = await gqlRequest(page, `
        query WorkspaceWorktrees($controllerId: ID!, $workspaceId: ID!) {
          workspaceWorktrees(controllerId: $controllerId, workspaceId: $workspaceId) { path sessionCount }
        }
      `, { controllerId: ctrl.controllerId, workspaceId }, token);
      const body = await res.json();
      const wt = (body.data?.workspaceWorktrees ?? []).find((w: { path: string }) => w.path === featureWorktreePath);
      return Boolean(wt) && wt.sessionCount === 0;
    }, 15000, 'waiting for worktree group sessionCount=0');
  });

  test('E2E-5: delete session triggers process cleanup', async ({ page }) => {
    test.setTimeout(60000);
    await loginViaUI(page, username);

    const sessionId = await createSession(page, ctrl.controllerId, token, workspaceId);
    expect(sessionId).toBeTruthy();

    await page.goto(`/sessions/${sessionId}`);
    await page.waitForTimeout(1000);

    await gqlRequest(page, `mutation DeleteSession($id: ID!) { deleteSession(id: $id) }`, { id: sessionId }, token);

    // DB 记录删除
    await waitFor(async () => {
      const res = await gqlRequest(page, `query Session($id: ID!) { session(id: $id) { id } }`, { id: sessionId }, token);
      const body = await res.json();
      return body.data?.session === null;
    }, 15000, 'waiting for session to be deleted');

    // fake controller 收到 acp:stop（进程终止信号到达）
    await waitFor(() => stoppedSessionIds.includes(sessionId), 15000, 'waiting for acp:stop to reach controller');
  });
});
