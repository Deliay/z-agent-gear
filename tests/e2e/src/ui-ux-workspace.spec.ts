import { test, expect } from '@playwright/test';
import { io as SocketIOClient } from 'socket.io-client';
import { registerUser, loginViaUI, createControllerKey } from './helpers';
import { gql, setupPhase4Env } from './phase4-helpers';

const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

function registerFakeController(rawKey: string, hostname: string): Promise<{ controllerId: string; disconnect: () => void }> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error('Timeout registering controller'));
    }, 10000);

    client.on('acp:check', (data: { requestId: string }) => {
      client.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
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
    client.emit('register', { key: rawKey, hostname, version: '2.0.0' });
  });
}

test.describe('UI/UX Workspace Shell & Navigation E2E', () => {
  test('E2E-UIUX-1: Desktop 3-Tier Workspace Shell renders ActivityRail, toggles Context Panel via button and Ctrl/Cmd+B, and focuses Sidebar sections', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const { username } = await registerUser(page, { prefix: 'uiux1' });
    await loginViaUI(page, username);

    const rail = page.locator('[data-testid="activity-rail"]');
    const sidebar = page.locator('nav[aria-label="侧边栏导航"]');

    await expect(rail).toBeVisible();
    await expect(sidebar).toBeVisible();

    // Collapse Context Panel via ActivityRail toggle button
    await rail.getByRole('button', { name: '收起列表栏' }).click();
    await expect(sidebar).toHaveCount(0);

    // Clicking a domain button in ActivityRail re-opens Context Panel and switches to focused domain view
    await rail.getByRole('button', { name: '聚焦主机分区' }).click();
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByTestId('context-panel-domain-hosts')).toBeVisible();
    await expect(sidebar.getByTestId('context-panel-domain-sessions')).toHaveCount(0);
    await expect(rail.getByTestId('rail-active-indicator')).toHaveCount(1);

    // Keyboard shortcut Ctrl+B toggles Context Panel collapse/expand
    await page.keyboard.press('Control+b');
    await expect(sidebar).toHaveCount(0);
    await page.keyboard.press('Control+b');
    await expect(sidebar).toBeVisible();
  });

  test('E2E-UIUX-3: ⌘K/Ctrl+K quick create panel opens existing dialogs and Esc closes', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const { username } = await registerUser(page, { prefix: 'uiux3' });
    await loginViaUI(page, username);

    // ⌘K / Ctrl+K 唤起全局快速新建面板
    await page.keyboard.press('Control+k');
    const panel = page.locator('[data-testid="quick-create-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('option', { name: /快速拉起会话/ })).toBeVisible();
    await expect(panel.getByRole('option', { name: /实例化工作流/ })).toBeVisible();

    // 选择「快速拉起会话」→ 打开既有新建会话对话框
    await panel.getByRole('option', { name: /快速拉起会话/ }).click();
    await expect(page.getByRole('dialog', { name: '新建会话' })).toBeVisible({ timeout: 15000 });

    // Esc 关闭
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '新建会话' })).toHaveCount(0);
  });

  test('E2E-UIUX-4: 状态色抽样（会话圆点 + 工作流节点徽标与状态矩阵一致）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const env = await setupPhase4Env(page, 'uiux4', { withSessions: true, withInstances: true });
    try {
      await loginViaUI(page, env.username);

      // 会话状态圆点：会话详情顶栏使用矩阵 dot（非旧徽标底色）
      const home = await gql<{ homeOverview: { sessions: Array<{ id: string }> } }>(
        page,
        env.token,
        'query { homeOverview { sessions { id } } }',
      );
      const sessionId = home.homeOverview.sessions[0]?.id;
      if (sessionId) {
        await page.goto(`/sessions/${sessionId}`);
        const dot = page.getByTestId('session-status-dot');
        await expect(dot).toBeVisible({ timeout: 15000 });
        await expect(dot).toHaveClass(/bg-(info|success|warning|muted-foreground|destructive)/);
      }

      // 工作流节点徽标：DONE/READY 状态使用矩阵 badge（data-status 同时落在卡片与徽标）
      const instance = env.instances[0];
      await page.goto(`/workflows/${instance.id}`);
      await page.getByRole('button', { name: '图表' }).click();
      const nodeId = instance.nodes[0]?.id;
      const badge = page.getByTestId(`node-status-badge-${nodeId}`);
      await expect(badge).toBeVisible({ timeout: 15000 });
      await expect(badge).toHaveClass(/bg-/);
      await expect(badge).toHaveAttribute('data-status', /READY|RUNNING|DONE|REWORK|REJECT|FAILED/);

      // 会话/工作流均由同一 status-matrix 消费，不存在就地 hex 色
      const card = page.getByTestId(`workflow-node-card-${nodeId}`);
      await expect(card).toHaveClass(/bg-card/);
    } finally {
      env.controllers.forEach((controller) => controller.disconnect());
    }
  });

  test('E2E-UIUX-5: 设置导航激活态 + 分组标题复核', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const { username } = await registerUser(page, { prefix: 'uiux5' });
    await loginViaUI(page, username);

    await page.locator('[data-testid="activity-rail"]').getByRole('button', { name: '设置中心' }).click();
    const settingsNav = page.locator('nav[aria-label="设置导航"]');
    await expect(settingsNav).toBeVisible({ timeout: 15000 });
    await expect(settingsNav.getByRole('heading', { name: '设置', exact: true })).toBeVisible();

    for (const group of ['帐号', 'Git', '模型设置', '本地控制器', 'MCP', '工作流']) {
      await expect(settingsNav.getByText(group, { exact: true }).first()).toBeVisible();
    }

    const modelButton = settingsNav.getByRole('button', { name: '可用模型' });
    await modelButton.click();
    await expect(modelButton).toHaveAttribute('data-active', 'true');
    await expect(settingsNav.getByRole('button', { name: '帐号' })).not.toHaveAttribute('data-active', 'true');
  });

  test('E2E-UIUX-2: Settings navigation highlights active section and Controller Config displays breadcrumb header', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const { token, username } = await registerUser(page, { prefix: 'uiux2' });
    const { rawKey } = await createControllerKey(page, token);
    const controller = await registerFakeController(rawKey, 'uiux-ctrl-host');

    try {
      await loginViaUI(page, username);
      await page.locator('[data-testid="activity-rail"]').getByRole('button', { name: '设置中心' }).click();
      await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible({ timeout: 15000 });

      const settingsNav = page.locator('nav[aria-label="设置导航"]');
      await expect(settingsNav).toBeVisible();

      // Default active section is '帐号'
      const accountBtn = settingsNav.getByRole('button', { name: '帐号', exact: true });
      await expect(accountBtn).toHaveAttribute('data-active', 'true');

      // Clicking '控制器管理' updates active nav highlight
      const controllerBtn = settingsNav.getByRole('button', { name: '控制器管理', exact: true });
      await controllerBtn.click();
      await expect(controllerBtn).toHaveAttribute('data-active', 'true');
      await expect(accountBtn).not.toHaveAttribute('data-active', 'true');

      // Navigate into Controller Config Page and verify breadcrumb header
      await page.goto(`/settings?controllerId=${controller.controllerId}`);
      const breadcrumb = page.locator('nav[aria-label="控制器配置面包屑"]');
      await expect(breadcrumb).toBeVisible({ timeout: 15000 });
      await expect(breadcrumb).toContainText('控制器');
      await expect(breadcrumb).toContainText('工作区配置');

      // Switch controller config section and verify breadcrumb updates active leaf
      await page.getByRole('button', { name: '可用 Harness 工具' }).click();
      await expect(breadcrumb).toContainText('可用 Harness 工具');

      // Click breadcrumb '设置' to return to settings overview
      await breadcrumb.getByRole('button', { name: '设置' }).click();
      await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    } finally {
      controller.disconnect();
    }
  });

  test('E2E-UIUX-6: 工作流实例详情顶栏、画布实例资源抽屉、节点选中高亮与无横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const env = await setupPhase4Env(page, 'uiux6', { withSessions: false, withInstances: true });
    try {
      await loginViaUI(page, env.username);
      const instance = env.instances[0];
      await page.goto(`/workflows/${instance.id}`);

      await expect(page.getByTestId('workflow-top-bar')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('workflow-progress-badge')).toContainText('已完成');

      // 切换图表模式并打开实例资源抽屉
      await page.getByRole('button', { name: '图表' }).click();
      await expect(page.getByTestId('workflow-inspector-toggle')).toBeVisible();
      await page.getByTestId('workflow-inspector-toggle').click();
      await expect(page.getByTestId('workflow-inspector-drawer')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('workflow-inspector-drawer')).toHaveCount(0);

      // 点击画布节点打开详情抽屉并验证节点选中态
      const nodeId = instance.nodes[0]?.id;
      const card = page.getByTestId(`workflow-node-card-${nodeId}`);
      await card.getByRole('button', { name: /详情/ }).click();
      await expect(page.getByTestId('node-detail-drawer')).toBeVisible();
      await expect(card).toHaveAttribute('data-selected', 'true');

      // 无横向溢出
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    } finally {
      env.controllers.forEach((controller) => controller.disconnect());
    }
  });
});

