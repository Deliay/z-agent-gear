import { test, expect, type Page } from '@playwright/test';
import { ADMIN_WEB_URL, adminGqlRequest, adminLoginApi, adminLoginViaUI } from './helpers.js';

// 计划用例覆盖说明（Phase 8）：
// - T-E1 启动 idle 容器、T-E3 强制销毁：本文件 UI 覆盖。
// - T-E2 未带/伪 token 被拒：见 tests/api/src/cloud-controller/worker-handshake.test.ts。
// - T-E5 非管理员/未登录访问拒绝：本文件覆盖（ProtectedRoute 重定向）。
// - T-E4 异常退出/超时保留 exitReason 且可强制销毁、T-E6 列表与 Job 实际状态对账：
//   K8S_ENABLED=false 下无真实 Job 可对账，改由 cloud-controller 单测锚定
//   （status-sync.test.ts T-Y1/T-Y3/T-Y5 + reconcile；container-service.test.ts T-S4/T-S4b）。
//   真实集群链路按计划列为部署侧手工验收。

interface ContainerNode {
  id: string;
  name: string;
  status: string;
  purpose: string;
}

const LIST = `query { adminCloudContainers { id name status purpose } }`;

async function listContainers(page: Page, token: string): Promise<ContainerNode[]> {
  const res = await adminGqlRequest(page, LIST, undefined, token);
  const body = await res.json();
  return (body.data?.adminCloudContainers ?? []) as ContainerNode[];
}

async function destroyViaApi(page: Page, token: string, id: string) {
  await adminGqlRequest(page, `mutation($id: ID!) { adminDestroyCloudContainer(id: $id) }`, { id }, token);
}

test.describe('Admin Cloud Container E2E', () => {
  test('should show the cloud container page and start dialog (idle only)', async ({ page }) => {
    await adminLoginApi(page);
    await adminLoginViaUI(page);

    await page.getByRole('link', { name: /云端容器/ }).click();
    await expect(page).toHaveURL(/\/cloud-containers/);
    await expect(page.getByRole('heading', { name: '云端容器' })).toBeVisible();
    await expect(page.getByRole('button', { name: '启动', exact: true })).toBeVisible();

    // 启动对话框：本期仅 idle（T-E1/PRD 3.4）
    await page.getByRole('button', { name: '启动', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('启动容器')).toBeVisible();
    await expect(dialog.getByText(/本期仅支持 idle/)).toBeVisible();
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('should start an idle container and force-destroy it (T-E1/T-E3)', async ({ page }) => {
    const token = await adminLoginApi(page);
    const before = await listContainers(page, token);
    const beforeIds = new Set(before.map((c) => c.id));

    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /云端容器/ }).click();

    await page.getByRole('button', { name: '启动', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '确认启动' }).click();
    await expect(dialog).not.toBeVisible();

    // 通过 API 找到新建的容器（zag-worker-*）
    let created: ContainerNode | undefined;
    for (let i = 0; i < 20 && !created; i += 1) {
      const now = await listContainers(page, token);
      created = now.find((c) => !beforeIds.has(c.id));
      if (!created) await page.waitForTimeout(500);
    }
    expect(created, 'newly started container should be listed').toBeTruthy();
    expect(created!.name.startsWith('zag-worker-')).toBe(true);
    expect(['CREATING', 'CONNECTING', 'ONLINE']).toContain(created!.status);

    // UI 中可见该容器行
    const row = page.locator('tr', { hasText: created!.name }).first();
    await expect(row).toBeVisible();

    // 强制销毁二次确认（T-E3）
    await row.getByRole('button', { name: /强制销毁/ }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('heading', { name: '强制销毁容器' })).toBeVisible();
    await confirm.getByRole('button', { name: '强制销毁' }).click();

    // 轮询 API 直到状态为 EXITED
    let status = '';
    for (let i = 0; i < 20; i += 1) {
      const now = await listContainers(page, token);
      status = now.find((c) => c.id === created!.id)?.status ?? '';
      if (status === 'EXITED') break;
      await page.waitForTimeout(500);
    }
    expect(status).toBe('EXITED');

    // 兜底清理
    await destroyViaApi(page, token, created!.id);
  });

  test('T-E5: unauthenticated access to /cloud-containers is redirected to login', async ({ page }) => {
    await page.goto(`${ADMIN_WEB_URL}/cloud-containers`);
    await expect(page).toHaveURL(/\/login/);
  });
});
