import { test, expect } from '@playwright/test';
import { io as SocketIOClient } from 'socket.io-client';
import { registerUser, loginViaUI, gqlRequest, createControllerKey, createWorkspace, createSession } from './helpers';

/**
 * 会话归档 / 工作区删除连带归档 / 工作区缺失只读（Phase 9，计划 §4.3）：
 *
 * - E2E-SARCH1：会话页归档 → 侧边栏活跃列表消失、「已归档（1）」出现、打开可查看、取消归档恢复；
 * - E2E-SARCH2：删除工作区确认文案含连带会话数量 → 确认后该工作区会话进入「已归档」分组且可打开；
 * - E2E-SRO1：删除工作区后的会话只读提示条（`session-readonly-notice`）出现、输入框与「继续」隐藏、历史消息仍可见
 *   （云电脑销毁只读回归由 `cloud-host-readonly.spec.ts` T-AW10/R2-10 覆盖，此处不重复）。
 */
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';

interface AcpStartEvent {
  requestId: string;
  sessionId: string;
}

/** fake controller：应答 acp:check / acp:start / git:worktree:list，并对 acp:stop 补 ack（连带归档会关闭活跃会话）。 */
function registerController(rawKey: string): Promise<{ controllerId: string; disconnect: () => void }> {
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

    client.on('git:worktree:list', (data: { requestId: string }) => {
      client.emit('git:worktree:list:result', { requestId: data.requestId, success: true, worktrees: [] });
    });

    client.on('acp:start', (data: AcpStartEvent) => {
      client.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
      });
    });

    client.on('acp:stop', (data: { sessionId: string; ackRequired?: boolean }) => {
      if (data.ackRequired) {
        client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'workspace_deleted', killed: true });
      }
    });

    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve({ controllerId: data.controllerId, disconnect: () => client.disconnect() });
    });
    client.once('error', (data: { message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Register failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname: 'e2e-sarch-host', version: '2.0.0' });
  });
}

const sidebarSessionList = () => '[data-testid="sidebar-session-list"]';
const sidebarArchivedList = () => '[data-testid="sidebar-archived-session-list"]';

test.describe('会话归档与工作区连带归档 E2E', () => {
  test('E2E-SARCH1 归档 → 活跃列表消失、「已归档（1）」出现、可打开、取消归档恢复', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-sarch1-${Date.now().toString(36)}`, token);
    const sessionId = await createSession(page, controllerId, token, ws.id);

    try {
      await loginViaUI(page, username);
      await page.goto(`/sessions/${sessionId}`);
      await expect(page.getByRole('button', { name: '归档', exact: true })).toBeVisible({ timeout: 15000 });

      // 归档前：侧边栏活跃列表包含该会话
      const sessionList = page.locator(sidebarSessionList());
      await expect(sessionList.locator(`a[href="/sessions/${sessionId}"]`)).toBeVisible({ timeout: 20000 });

      // 归档：toast + 返回会话列表
      await page.getByRole('button', { name: '归档', exact: true }).click();
      await expect(page).toHaveURL('/sessions', { timeout: 10000 });
      await expect(page.getByText('会话已归档')).toBeVisible({ timeout: 10000 });

      // 侧边栏：活跃列表消失、「已归档（1）」出现
      await expect(sessionList.locator(`a[href="/sessions/${sessionId}"]`)).toHaveCount(0, { timeout: 20000 });
      const archivedGroup = page.getByRole('button', { name: '已归档（1）' });
      await expect(archivedGroup).toBeVisible({ timeout: 20000 });

      // 展开分组后条目可打开
      await archivedGroup.click();
      const archivedList = page.locator(sidebarArchivedList());
      await expect(archivedList.locator(`a[href="/sessions/${sessionId}"]`)).toBeVisible();
      await archivedList.locator(`a[href="/sessions/${sessionId}"]`).click();
      await expect(page).toHaveURL(`/sessions/${sessionId}`);
      await expect(page.getByTestId('session-archived-badge')).toBeVisible({ timeout: 10000 });
      await expect(page.getByRole('button', { name: '取消归档', exact: true })).toBeVisible();

      // 取消归档：恢复活跃分组
      await page.getByRole('button', { name: '取消归档', exact: true }).click();
      await expect(page.getByText('已取消归档')).toBeVisible({ timeout: 10000 });
      await expect(
        page.locator(sidebarSessionList()).locator(`a[href="/sessions/${sessionId}"]`),
      ).toBeVisible({ timeout: 20000 });
      await expect(page.getByRole('button', { name: /已归档（\d+）/ })).toHaveCount(0, { timeout: 20000 });
    } finally {
      disconnect();
    }
  });

  test('E2E-SARCH2 删除工作区确认文案含会话数量 → 确认后会话进入「已归档」分组', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-sarch2-${Date.now().toString(36)}`, token);
    const s1 = await createSession(page, controllerId, token, ws.id);
    const s2 = await createSession(page, controllerId, token, ws.id);

    try {
      await loginViaUI(page, username);

      // 设置 → 控制器配置页
      await page.click('a[href="/settings"]');
      await expect(page.locator('#controller-section')).toBeVisible({ timeout: 5000 });
      await page.locator('#controller-section').getByRole('button', { name: '配置' }).first().click();
      await expect(page.getByRole('heading', { name: '工作区' })).toBeVisible({ timeout: 5000 });
      await expect(page.getByText(ws.path)).toBeVisible({ timeout: 5000 });

      // 删除前置 impact：确认文案含连带会话数量 2
      await page.getByRole('button', { name: '删除' }).first().click();
      await expect(page.getByText('删除工作区将同时归档其下 2 个会话，是否继续？')).toBeVisible({
        timeout: 15000,
      });
      await page.getByRole('button', { name: '确认删除' }).click();
      await expect(page.getByText('暂无工作区，点击「添加」开始配置')).toBeVisible({ timeout: 10000 });

      // 侧边栏「已归档（2）」分组可见可打开（homeOverview 15s 轮询，放宽等待）
      await page.goto('/sessions');
      const archivedGroup = page.getByRole('button', { name: '已归档（2）' });
      await expect(archivedGroup).toBeVisible({ timeout: 25000 });
      await archivedGroup.click();
      const archivedList = page.locator(sidebarArchivedList());
      await expect(archivedList.locator(`a[href="/sessions/${s1}"]`)).toBeVisible();
      await expect(archivedList.locator(`a[href="/sessions/${s2}"]`)).toBeVisible();

      await archivedList.locator(`a[href="/sessions/${s1}"]`).click();
      await expect(page).toHaveURL(`/sessions/${s1}`);
      await expect(page.getByTestId('session-archived-badge')).toBeVisible({ timeout: 10000 });
    } finally {
      disconnect();
    }
  });

  test('E2E-SRO1 工作区删除后的会话只读提示条、输入与「继续」隐藏、历史消息可见', async ({ page }) => {
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const { controllerId, disconnect } = await registerController(rawKey);
    const ws = await createWorkspace(page, controllerId, `/tmp/e2e-sro1-${Date.now().toString(36)}`, token);
    const sessionId = await createSession(page, controllerId, token, ws.id);

    try {
      // 可写期先落一条历史消息（真实 sendSessionMessage 落库）
      const historyText = `只读回看历史-${Date.now().toString(36)}`;
      const sendRes = await gqlRequest(
        page,
        `mutation Send($sessionId: ID!, $content: String!) {
          sendSessionMessage(sessionId: $sessionId, content: $content) { id }
        }`,
        { sessionId, content: historyText },
        token,
      );
      const sendBody = await sendRes.json();
      expect(sendBody.errors).toBeUndefined();
      expect(sendBody.data?.sendSessionMessage?.id).toBeTruthy();

      // 删除工作区：连带归档 + 工作区缺失（只读）
      const delRes = await gqlRequest(
        page,
        `mutation Delete($id: ID!) { deleteWorkspace(id: $id) }`,
        { id: ws.id },
        token,
      );
      const delBody = await delRes.json();
      expect(delBody.errors).toBeUndefined();
      expect(delBody.data.deleteWorkspace).toBe(true);

      await loginViaUI(page, username);
      await page.goto(`/sessions/${sessionId}`);

      // 只读提示条（WORKSPACE_MISSING 三态文案）
      const notice = page.getByTestId('session-readonly-notice');
      await expect(notice).toBeVisible({ timeout: 15000 });
      await expect(notice).toContainText('工作区已不存在，会话记录仅供只读回看。');

      // 输入框与「继续」隐藏，历史消息仍可见
      await expect(page.getByRole('textbox')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /继续/ })).toHaveCount(0);
      await expect(page.getByText(historyText)).toBeVisible({ timeout: 15000 });
    } finally {
      disconnect();
    }
  });
});
