import { test, expect } from '@playwright/test';
import {
  loginViaUI,
  registerFundedUser,
  createControllerKey,
  registerController,
  createWorkspace,
} from './helpers';

// Github 工作负载 E2E（需要 HARNESS_ENABLED=true 的真实云主机）。
// 真实 GitHub API 不在 E2E 中调用：未绑定账号路径只验证引导与禁用态；
// 成功 clone/凭据/会话链路由单测 + 部署侧手工验收覆盖。
const HARNESS_ENABLED = process.env.HARNESS_ENABLED === 'true';
const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';

async function createHost(page: import('@playwright/test').Page, token: string, name: string) {
  const response = await page.request.post(API_URL, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: {
      query: `mutation Create($input: CreateCloudHostInput!) {
        createCloudHost(input: $input) { id controllerId name status }
      }`,
      variables: { input: { name, harnessTypes: ['OPENCODE'] } },
    },
  });
  const body = (await response.json()) as any;
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data.createCloudHost as { id: string; controllerId: string };
}

async function waitForRunning(
  page: import('@playwright/test').Page,
  token: string,
  name: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = (await page.request
      .post(API_URL, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        data: { query: `query { myCloudHosts { name status } }` },
      })
      .then((res) => res.json())) as any;
    const host = body.data?.myCloudHosts?.find((item: { name: string }) => item.name === name);
    if (host?.status === 'RUNNING') return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

test.describe('Github workload E2E', () => {
  test.skip(!HARNESS_ENABLED, 'HARNESS_ENABLED=false：云电脑入口关闭');

  test('T-EG5: Git 设置/新增工作区后「+」重新打开即时可见（无需刷新页面）', async ({ page }) => {
    const { token, username } = await registerFundedUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const controller = await registerController(rawKey);
    const firstPath = `/home/worker/workspace/phase10-first-${Date.now().toString(36)}`;
    await createWorkspace(page, controller.controllerId, firstPath, token);

    await loginViaUI(page, username);
    await page.goto('/sessions');
    await page.locator('main').getByRole('button', { name: '新建会话' }).click();
    let dialog = page.getByRole('dialog');
    await dialog.locator('#controller').selectOption({ index: 1 });
    const firstTrigger = dialog.locator('[data-slot="select-trigger"][aria-label="工作区"]');
    await firstTrigger.click();
    await expect(page.getByRole('option', { name: new RegExp(firstPath) })).toBeVisible({ timeout: 15000 });
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: '取消' }).click();

    // 模拟 Git 项目设置成功后新增的工作区（真实环境由 setup 写入）
    const secondPath = `/home/worker/workspace/phase10-git-${Date.now().toString(36)}`;
    await createWorkspace(page, controller.controllerId, secondPath, token);

    // 再次打开「+」：打开即 refetch 工作区，无需刷新页面
    await page.locator('main').getByRole('button', { name: '新建会话' }).click();
    dialog = page.getByRole('dialog');
    await dialog.locator('#controller').selectOption({ index: 1 });
    const workspaceTrigger = dialog.locator('[data-slot="select-trigger"][aria-label="工作区"]');
    await workspaceTrigger.click();
    await expect(page.getByRole('option', { name: new RegExp(secondPath) })).toBeVisible({
      timeout: 15000,
    });

    controller.disconnect();
  });

  test('T-EG1/T-EG4: 云主机工作区 Github 图标 → 弹窗默认值与固定工作负载', async ({ page }) => {
    test.setTimeout(90_000);
    const { token, username } = await registerFundedUser(page);
    await loginViaUI(page, username);
    const name = `e2e-gh-${Date.now().toString(36)}`;
    await createHost(page, token, name);

    // Github 入口仅对 RUNNING 云电脑开放；K8S_ENABLED=false 时容器停在 STARTING，
    // 环境无法产生 RUNNING 主机 → 显式跳过（真实集群由部署侧验收）。
    test.skip(!(await waitForRunning(page, token, name)), '云电脑未达到 RUNNING：跳过 Github 入口用例');

    await page.reload();
    const sidebar = page.locator('nav[aria-label="Sidebar"]');
    await expect(sidebar.getByText(name, { exact: true })).toBeVisible({ timeout: 15000 });

    const controllerRow = sidebar.locator('li', { hasText: name });
    await controllerRow.getByLabel('Github 项目设置').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Git 项目设置' })).toBeVisible();
    await expect(dialog.getByLabel('目标主机')).toContainText(name);
    // 创建期不再预置默认工作区：无默认工作区时预填 ~/workspace（预览展开为 /home/worker/workspace）
    await expect(dialog.getByLabel('前缀地址')).toHaveValue('~/workspace');
    await expect(dialog.getByLabel('前缀地址')).toHaveAttribute('placeholder', '例如：~/workspace');
    // 前缀语义：预览 = <归一后前缀>/<User/Repo>；预填 ~/workspace 归一为 /home/worker/workspace，
    // 故显示具体路径而非 `<前缀>` 占位（`<前缀>` 仅在前缀为空/非法、normalizedPrefix === null 时出现）；
    // 未选仓库时最终地址行随之渲染，地址取值回退为 '—'
    await expect(dialog.getByText(/项目将 clone 到 \/home\/worker\/workspace\/<User\/Repo>/)).toBeVisible();
    await expect(dialog.getByText(/最终 clone 地址：—/)).toBeVisible();

    const githubCheckbox = dialog.getByRole('checkbox', { name: 'Github' });
    await expect(githubCheckbox).toBeChecked();
    await expect(githubCheckbox).toBeDisabled();

    // 新用户未绑定 Github：展示引导，确认禁用
    await expect(dialog.getByText('尚未绑定 Github 帐号')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '确认' })).toBeDisabled();

  });
});
