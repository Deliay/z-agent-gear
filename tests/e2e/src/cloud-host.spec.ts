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

test.describe('Cloud Host E2E', () => {
  test.skip(!HARNESS_ENABLED, 'HARNESS_ENABLED=false：云电脑入口关闭');

  test('T-AW2..T-AW9: create → starting → stop → stopped → delete', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await expect(page.locator(sidebar())).toBeVisible();

    const hostName = `e2e-cloud-${Date.now().toString(36)}`;

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
    await expect(page.getByRole('button', { name: '工作区' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Harness 工具' })).toBeVisible();

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

    // 清理兜底（删除失败时通过 API 兜底）
    const hosts = await gqlRequest(
      page,
      `query { myCloudHosts { id name } }`,
      undefined,
      token,
    ).then((res) => res.json());
    const leftover = hosts.data?.myCloudHosts?.find((host: { name: string }) => host.name === hostName);
    if (leftover) {
      await gqlRequest(
        page,
        `mutation($id: ID!) { stopCloudHost(id: $id, force: true) { id } }`,
        { id: leftover.id },
        token,
      );
      await gqlRequest(page, `mutation($id: ID!) { deleteCloudHost(id: $id) }`, { id: leftover.id }, token);
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
