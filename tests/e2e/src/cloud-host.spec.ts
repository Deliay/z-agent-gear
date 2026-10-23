import { test, expect } from '@playwright/test';
import { loginViaUI, registerUser } from './helpers';

// 云电脑 E2E：K8S_ENABLED=false 下只能覆盖 STARTING → 停止 → 已销毁 → 删除。
// 在线/默认会话/只读消息由 tests/api 回调用例与真实集群手工验收覆盖。
const HARNESS_ENABLED = process.env.HARNESS_ENABLED === 'true';
const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';

function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return page.request.post(API_URL, { headers, data: { query, variables } });
}

const sidebar = () => 'nav[aria-label="Sidebar"]';
const API_BASE = API_URL.replace(/\/graphql\/?$/, '');

const HOST_FLAGS = `
  query {
    myCloudHosts { id name controllerId status defaultSessionId hasDefaultWorkspace }
  }
`;
const WORKSPACE_LIST = `query { workspaces { id controllerId path } }`;

async function hostFlags(
  page: import('@playwright/test').Page,
  token: string,
  name: string,
): Promise<{ id: string; controllerId: string; status: string; defaultSessionId: string | null; hasDefaultWorkspace: boolean } | undefined> {
  const res = await gqlRequest(page, HOST_FLAGS, undefined, token);
  const body = await res.json();
  return (body.data?.myCloudHosts ?? []).find((host: { name: string }) => host.name === name);
}

async function cleanupHost(page: import('@playwright/test').Page, token: string, id: string) {
  await gqlRequest(page, `mutation($id: ID!) { stopCloudHost(id: $id, force: true) { id } }`, { id }, token);
  await gqlRequest(page, `mutation($id: ID!) { deleteCloudHost(id: $id) }`, { id }, token);
}

test.describe('Cloud Host E2E', () => {
  test.skip(!HARNESS_ENABLED, 'HARNESS_ENABLED=false：云电脑入口关闭');

  test('T-AW2..T-AW9: create → starting → stop → stopped → delete', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await expect(page.locator(sidebar())).toBeVisible();

    const hostName = `e2e-cloud-${Date.now().toString(36)}`;

    try {
      await page.getByRole('button', { name: '新建云电脑' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '新建云电脑' })).toBeVisible();

      // 名称必填 + harness 必选；本期无存储/会话导入参数
      const createButton = dialog.getByRole('button', { name: '创建云电脑' });
      await expect(createButton).toBeDisabled();
      await expect(dialog.getByText('存储会话')).toHaveCount(0);
      await expect(dialog.getByText('恢复的会话')).toHaveCount(0);

      await dialog.locator('#cloud-host-name').fill('   ');
      await expect(createButton).toBeDisabled();
      await expect(dialog.getByText('请输入云电脑名称')).toBeVisible();

      await dialog.locator('#cloud-host-name').fill(hostName);
      await dialog.getByRole('checkbox', { name: 'OpenCode' }).check();
      await expect(dialog.getByText('将自动创建会话')).toBeVisible();

      // 预装工作负载来自 cloudHostWorkloadCatalog（迁移 001/002/007 seed）
      await expect(dialog.getByText('预装工作负载（可选）')).toBeVisible();
      for (const name of ['Aspire', 'Docker', '.NET']) {
        await expect(dialog.getByRole('checkbox', { name, exact: true })).toBeVisible({
          timeout: 15000,
        });
      }
      await expect(dialog.getByText('依赖：Docker、.NET')).toBeVisible();
      await dialog.getByRole('checkbox', { name: 'Docker', exact: true }).check();
      await expect(dialog.getByText('勾选运行环境负载会延长首次就绪时间')).toBeVisible();

      await expect(createButton).toBeEnabled();
      await createButton.click();

      await expect(page.locator(sidebar()).getByText(hostName, { exact: true })).toBeVisible({
        timeout: 15000,
      });
      const controllerRow = page.locator(sidebar()).locator('li', { hasText: hostName });
      await expect(controllerRow.getByTestId('cloud-host-icon')).toBeVisible();
      await expect(controllerRow.getByTestId('cloud-host-status')).toHaveText('启动中');

      await controllerRow.getByTitle('控制器配置').click();
      await expect(page).toHaveURL(/\/settings\?controllerId=/);
      await expect(page.getByTestId('cloud-host-panel')).toBeVisible();
      await expect(page.getByTestId('cloud-host-panel')).toContainText('启动中');
      // 工作区 + Harness 工具两栏与普通主机一致
      await expect(page.getByTestId('config-tab-workspace')).toBeVisible();
      await expect(page.getByTestId('config-tab-harness')).toBeVisible();

      // 无活动会话：直接停止（不弹告警）
      await page.getByRole('button', { name: '停止云电脑' }).click();
      await expect(page.getByTestId('cloud-host-panel')).toContainText('已销毁', { timeout: 15000 });
      await expect(page.getByText('停止云主机会导致所有会话永久丢失，是否继续')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '停止云电脑' })).toHaveCount(0);

      // 终态才允许删除
      await page.getByRole('button', { name: '删除云电脑' }).click();
      await expect(page.getByRole('heading', { name: '删除云电脑' })).toBeVisible();
      await page.getByRole('button', { name: '确认删除' }).click();
      await expect(page.getByTestId('cloud-host-panel')).toHaveCount(0, { timeout: 15000 });
      await expect(page.locator(sidebar()).getByText(hostName, { exact: true })).toHaveCount(0, {
        timeout: 15000,
      });
    } finally {
      // 兜底清理放在 finally：任一断言失败也不会遗留云电脑（先停后删）
      const hosts = await gqlRequest(
        page,
        `query { myCloudHosts { id name } }`,
        undefined,
        token,
      ).then((res) => res.json());
      const leftover = hosts.data?.myCloudHosts?.find(
        (host: { name: string }) => host.name === hostName,
      );
      if (leftover) {
        // R2-23：stop/delete 任一步失败都继续尝试后续步骤，避免残留主机
        try {
          await gqlRequest(
            page,
            `mutation($id: ID!) { stopCloudHost(id: $id, force: true) { id } }`,
            { id: leftover.id },
            token,
          );
        } catch {
          /* 已停止或控制面不可用：继续尝试删除 */
        }
        try {
          await gqlRequest(page, `mutation($id: ID!) { deleteCloudHost(id: $id) }`, { id: leftover.id }, token);
        } catch {
          /* 删除失败无法进一步回收：保留日志由运维巡检处理 */
        }
      }
    }
  });

  test('E2E-1: 默认不勾选 → 不创建工作区、不自动建会话并展示无工作区提示', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await expect(page.locator(sidebar())).toBeVisible();

    const hostName = `e2e-nows-${Date.now().toString(36)}`;
    let hostId = '';

    try {
      await page.getByRole('button', { name: '新建云电脑' }).click();
      const dialog = page.getByRole('dialog');
      const checkbox = dialog.getByRole('checkbox', { name: /创建默认工作区/ });
      await expect(checkbox).not.toBeChecked();
      await expect(dialog.getByText('不会创建工作区，就绪后需先创建或绑定工作区')).toBeVisible();

      await dialog.locator('#cloud-host-name').fill(hostName);
      await dialog.getByRole('checkbox', { name: 'OpenCode' }).check();
      await expect(dialog.getByText('将自动创建会话')).toBeVisible();
      await dialog.getByRole('button', { name: '创建云电脑' }).click();

      const controllerRow = page.locator(sidebar()).locator('li', { hasText: hostName });
      await expect(controllerRow).toBeVisible({ timeout: 15000 });

      const host = await hostFlags(page, token, hostName);
      expect(host, 'created cloud host should be listed').toBeTruthy();
      hostId = host!.id;
      expect(host!.hasDefaultWorkspace).toBe(false);
      expect(host!.defaultSessionId).toBeNull();

      const wsRes = await gqlRequest(page, WORKSPACE_LIST, undefined, token);
      const workspaces = ((await wsRes.json()).data?.workspaces ?? []).filter(
        (workspace: { controllerId: string }) => workspace.controllerId === host!.controllerId,
      );
      expect(workspaces).toEqual([]);

      // 真实 ready 回调可用时（K8s 关闭的本地链路），验证 RUNNING 后的提示与无默认会话
      const internalToken = process.env.INTERNAL_API_TOKEN;
      if (internalToken) {
        const ready = await page.request.post(`${API_BASE}/internal/cloud-hosts/${hostId}/ready`, {
          headers: { Authorization: `Bearer ${internalToken}` },
        });
        if (ready.ok()) {
          // 重新拉取首页数据，避免依赖侧栏轮询时机
          await page.reload();
          await expect(page.locator(sidebar())).toBeVisible();
          await expect(controllerRow.getByTestId('cloud-host-no-workspace-hint')).toHaveText(
            '未创建默认工作区，请先创建或绑定工作区',
            { timeout: 15000 },
          );
          await expect(
            controllerRow.getByTestId('cloud-host-default-session-hint'),
          ).toHaveCount(0);
          const running = await hostFlags(page, token, hostName);
          expect(running?.status).toBe('RUNNING');
          expect(running?.defaultSessionId).toBeNull();
        }
      }
    } finally {
      if (hostId) await cleanupHost(page, token, hostId);
    }
  });

  test('E2E-2: 勾选创建默认工作区 → 与现状一致创建工作区', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await expect(page.locator(sidebar())).toBeVisible();

    const hostName = `e2e-ws-${Date.now().toString(36)}`;
    let hostId = '';

    try {
      await page.getByRole('button', { name: '新建云电脑' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('#cloud-host-name').fill(hostName);
      await dialog.getByRole('checkbox', { name: 'OpenCode' }).check();
      await dialog.getByRole('checkbox', { name: /创建默认工作区/ }).check();
      await expect(dialog.getByText('将创建默认工作区并自动创建会话')).toBeVisible();
      await dialog.getByRole('button', { name: '创建云电脑' }).click();

      await expect(page.locator(sidebar()).getByText(hostName, { exact: true })).toBeVisible({
        timeout: 15000,
      });
      const host = await hostFlags(page, token, hostName);
      expect(host, 'created cloud host should be listed').toBeTruthy();
      hostId = host!.id;
      expect(host!.hasDefaultWorkspace).toBe(true);

      const wsRes = await gqlRequest(page, WORKSPACE_LIST, undefined, token);
      const workspaces = ((await wsRes.json()).data?.workspaces ?? []).filter(
        (workspace: { controllerId: string }) => workspace.controllerId === host!.controllerId,
      );
      expect(workspaces.map((workspace: { path: string }) => workspace.path)).toContain(
        '/root/workspace',
      );
    } finally {
      if (hostId) await cleanupHost(page, token, hostId);
    }
  });

  test('T-AW3/T-AW5: surfaces server validation errors', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);

    await page.getByRole('button', { name: '新建云电脑' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#cloud-host-name').fill('x'.repeat(65));
    await dialog.getByRole('checkbox', { name: 'OpenCode' }).check();
    await expect(dialog.getByText('名称不能超过 64 个字符')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '创建云电脑' })).toBeDisabled();
  });
});
