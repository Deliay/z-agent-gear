import { test, expect } from '@playwright/test';
import { io as SocketIOClient } from 'socket.io-client';
import { registerUser, loginViaUI, createControllerKey } from './helpers';

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
    const sidebar = page.locator('nav[aria-label="Sidebar"]');

    await expect(rail).toBeVisible();
    await expect(sidebar).toBeVisible();

    // Collapse Context Panel via ActivityRail toggle button
    await rail.getByRole('button', { name: '收起列表栏' }).click();
    await expect(sidebar).toHaveCount(0);

    // Clicking a domain button in ActivityRail re-opens Context Panel and expands target section
    await rail.getByRole('button', { name: '聚焦主机分区' }).click();
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole('button', { name: /^主机/ })).toHaveAttribute('aria-expanded', 'true');

    // Keyboard shortcut Ctrl+B toggles Context Panel collapse/expand
    await page.keyboard.press('Control+b');
    await expect(sidebar).toHaveCount(0);
    await page.keyboard.press('Control+b');
    await expect(sidebar).toBeVisible();
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

      const settingsNav = page.locator('nav[aria-label="Settings navigation"]');
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
});
