import { test, expect, type Page } from '@playwright/test';
import {
  adminGqlRequest,
  adminLoginApi,
  createFrontUser,
  loginViaUI,
} from './helpers';

/**
 * 多租户二期工作区 E2E（计划 Phase 10 / E2E-WS）。
 *
 * 覆盖：
 * - 切换器按租户分组/按角色过滤 + 本地持久化（refresh 后恢复）；
 * - 工作区管理页仅 team admin 可操作，developer 只读提示；
 * - 租户成员管理页：搜索添加 / 指定角色 / 变更角色 / last-admin 提示 / developer 无入口；
 * - 个人租户用户无切换器（零感知）；
 * - 团队全局工作区 + developer：设置页只读收敛。
 *
 * 数据经 admin-api（adminCreateTeamTenant / adminAddTenantMember）+ agent-api GraphQL 准备，
 * 需要 INTERNAL_API_TOKEN 或 MONGODB_URI（开户 helper 口径）。
 */

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const FRONT_WEB_URL = process.env.BASE_URL || 'http://localhost:35273';
const sidebar = () => 'nav[aria-label="Sidebar"]';

/** 测试内需要第二个干净登录态（localStorage 隔离）；新 context 必须显式带上 baseURL。 */
function newIsolatedPage(page: Page): Promise<Page> {
  return page.context().browser()!.newContext({ baseURL: FRONT_WEB_URL }).then((context) => context.newPage());
}

interface TeamFixture {
  teamId: string;
  teamName: string;
  globalWorkspaceId: string;
  normalWorkspaceId: string;
  normalWorkspaceName: string;
  owner: { token: string; username: string; userId: string };
  developer: { token: string; username: string; userId: string };
}

let adminTokenCache: string | null = null;

async function adminToken(page: Page): Promise<string> {
  if (!adminTokenCache) adminTokenCache = await adminLoginApi(page);
  return adminTokenCache;
}

async function adminGqlAs<T = any>(
  page: Page,
  query: string,
  variables: Record<string, unknown> | undefined,
  token: string,
): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  const res = await adminGqlRequest(page, query, variables, token);
  return (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
}

async function gqlAs<T = any>(
  page: Page,
  query: string,
  variables: Record<string, unknown> | undefined,
  token: string,
  workspaceId?: string,
): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (workspaceId) headers['x-workspace-id'] = workspaceId;
  const res = await page.request.post(API_URL, {
    headers,
    data: { query, variables },
  });
  return (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
}

async function createTeamFixture(page: Page): Promise<TeamFixture> {
  const token = await adminToken(page);
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const teamName = `e2e-ws-${suffix}`.slice(0, 60);

  const owner = await createFrontUser(page, { prefix: 'wso' });
  const developer = await createFrontUser(page, { prefix: 'wsd' });

  const created = await adminGqlAs<{
    adminCreateTeamTenant: { id: string; name: string };
  }>(page, `
    mutation CreateTeamTenant($name: String!) {
      adminCreateTeamTenant(name: $name) { id name type }
    }
  `, { name: teamName }, token);
  expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
  const teamId = created.data!.adminCreateTeamTenant.id;

  const detail = await adminGqlAs<{
    adminTenant: { workspaces: Array<{ id: string; type: string; name: string }> } | null;
  }>(page, `
    query Tenant($id: ID!) {
      adminTenant(id: $id) { workspaces { id type name } }
    }
  `, { id: teamId }, token);
  expect(detail.errors, JSON.stringify(detail.errors)).toBeUndefined();
  const globalWorkspace = detail.data!.adminTenant!.workspaces.find((workspace) => workspace.type === 'global');
  expect(globalWorkspace, 'team 租户应自动开通全局工作区').toBeTruthy();

  for (const [username, role] of [
    [owner.username, 'admin'],
    [developer.username, 'developer'],
  ] as const) {
    const added = await adminGqlAs(page, `
      mutation AddMember($tenantId: ID!, $username: String!, $role: TenantRole) {
        adminAddTenantMember(tenantId: $tenantId, username: $username, role: $role) {
          id username role
        }
      }
    `, { tenantId: teamId, username, role }, token);
    expect(added.errors, JSON.stringify(added.errors)).toBeUndefined();
  }

  const normalWorkspaceName = `normal-${suffix}`;
  const normal = await gqlAs<{ createTenantWorkspace: { id: string; name: string } }>(
    page,
    `mutation CreateWorkspace($name: String!) {
      createTenantWorkspace(name: $name) { id name type }
    }`,
    { name: normalWorkspaceName },
    owner.token,
    globalWorkspace!.id,
  );
  expect(normal.errors, JSON.stringify(normal.errors)).toBeUndefined();

  return {
    teamId,
    teamName,
    globalWorkspaceId: globalWorkspace!.id,
    normalWorkspaceId: normal.data!.createTenantWorkspace.id,
    normalWorkspaceName,
    owner,
    developer,
  };
}

async function optionValues(page: Page): Promise<string[]> {
  return page.locator('#workspace-switcher-select option').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLOptionElement).value),
  );
}

test.describe('多租户二期工作区 E2E（E2E-WS）', () => {
  test('E2E-WS1 切换器按角色过滤：admin 见全部工作区，developer 仅全局', async ({ page }) => {
    const fixture = await createTeamFixture(page);

    await loginViaUI(page, fixture.owner.username);
    await expect(page.locator(sidebar())).toBeVisible();
    await expect(page.getByTestId('workspace-switcher')).toBeVisible();

    const adminValues = await optionValues(page);
    expect(adminValues).toContain(fixture.globalWorkspaceId);
    expect(adminValues).toContain(fixture.normalWorkspaceId);
    // 切到团队工作区后管理入口出现（仅 team admin）
    await page.locator('#workspace-switcher-select').selectOption(fixture.globalWorkspaceId);
    await expect(page.locator('#workspace-switcher-select')).toHaveValue(fixture.globalWorkspaceId);
    await expect(page.getByRole('link', { name: '工作区管理' })).toBeVisible();
    await expect(page.getByRole('link', { name: '租户成员' })).toBeVisible();

    // 换一个浏览器上下文（localStorage 隔离）验证 developer 视角
    const devPage = await newIsolatedPage(page);
    await loginViaUI(devPage, fixture.developer.username);
    await expect(devPage.locator(sidebar())).toBeVisible();
    await expect(devPage.getByTestId('workspace-switcher')).toBeVisible();
    const devValues = await optionValues(devPage);
    expect(devValues).toContain(fixture.globalWorkspaceId);
    expect(devValues).not.toContain(fixture.normalWorkspaceId);
    // 即使切到团队全局工作区，developer 仍无管理入口
    await devPage.locator('#workspace-switcher-select').selectOption(fixture.globalWorkspaceId);
    await expect(devPage.locator('#workspace-switcher-select')).toHaveValue(fixture.globalWorkspaceId);
    await expect(devPage.getByRole('link', { name: '工作区管理' })).toHaveCount(0);
    await expect(devPage.getByRole('link', { name: '租户成员' })).toHaveCount(0);
    await devPage.context().close();
  });

  test('E2E-WS2 当前工作区选择持久化，刷新后恢复', async ({ page }) => {
    const fixture = await createTeamFixture(page);
    await loginViaUI(page, fixture.owner.username);
    await expect(page.getByTestId('workspace-switcher')).toBeVisible();

    const select = page.locator('#workspace-switcher-select');
    await select.selectOption(fixture.normalWorkspaceId);
    await expect(select).toHaveValue(fixture.normalWorkspaceId);

    const stored = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      `zag:current-workspace:${fixture.owner.userId}`,
    );
    expect(stored).toBe(fixture.normalWorkspaceId);

    await page.reload();
    await expect(page.locator(sidebar())).toBeVisible();
    await expect(page.locator('#workspace-switcher-select')).toHaveValue(fixture.normalWorkspaceId, {
      timeout: 15000,
    });
  });

  test('E2E-WS3 工作区管理仅 team admin：可创建，developer 无权限', async ({ page }) => {
    const fixture = await createTeamFixture(page);
    await loginViaUI(page, fixture.owner.username);
    await page.locator('#workspace-switcher-select').selectOption(fixture.globalWorkspaceId);
    await expect(page.locator('#workspace-switcher-select')).toHaveValue(fixture.globalWorkspaceId);
    await page.getByRole('link', { name: '工作区管理' }).click();
    await expect(page).toHaveURL(/\/workspaces$/);
    await expect(page.getByRole('button', { name: '新建工作区' })).toBeVisible();
    await expect(page.getByTestId(`workspace-row-${fixture.normalWorkspaceId}`)).toBeVisible();

    const createdName = `created-${Date.now().toString(36)}`;
    await page.getByRole('button', { name: '新建工作区' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('工作区名称').fill(createdName);
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(
      page.getByRole('list', { name: '工作区列表' }).getByText(createdName),
    ).toBeVisible({ timeout: 15000 });

    const devPage = await newIsolatedPage(page);
    await loginViaUI(devPage, fixture.developer.username);
    await devPage.locator('#workspace-switcher-select').selectOption(fixture.globalWorkspaceId);
    await expect(devPage.locator('#workspace-switcher-select')).toHaveValue(fixture.globalWorkspaceId);
    await devPage.goto('/workspaces');
    await expect(
      devPage.getByText('仅租户管理员可访问工作区管理（开发角色无入口）。'),
    ).toBeVisible({ timeout: 10000 });
    await expect(devPage.getByRole('button', { name: '新建工作区' })).toHaveCount(0);
    await devPage.context().close();
  });

  test('E2E-WS4 租户成员管理：admin 搜索添加/变更角色/last-admin 提示', async ({ page }) => {
    const fixture = await createTeamFixture(page);
    const member = await createFrontUser(page, { prefix: 'wsm' });

    await loginViaUI(page, fixture.owner.username);
    await page.locator('#workspace-switcher-select').selectOption(fixture.globalWorkspaceId);
    await expect(page.locator('#workspace-switcher-select')).toHaveValue(fixture.globalWorkspaceId);
    await page.getByRole('link', { name: '租户成员' }).click();
    await expect(page).toHaveURL(new RegExp(`/tenants/${fixture.teamId}/members$`));
    await expect(page.getByTestId(`tenant-member-row-${fixture.owner.userId}`)).toBeVisible();

    // 搜索并添加（默认角色 developer）
    await page.getByLabel('搜索帐号').fill(member.username);
    await page.getByRole('button', { name: '搜索' }).click();
    const results = page.getByRole('list', { name: '搜索结果' });
    await expect(results.getByText(`@${member.username}`)).toBeVisible({ timeout: 10000 });
    await results.getByRole('button', { name: '添加' }).click();
    const memberRow = page.getByTestId(`tenant-member-row-${member.userId}`);
    await expect(memberRow).toBeVisible({ timeout: 15000 });
    await expect(memberRow).toContainText('开发');

    // last-admin：owner 是当前唯一管理员，不能移除
    await page.getByTestId(`tenant-member-row-${fixture.owner.userId}`).getByRole('button', { name: '移除' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByText('移除租户成员')).toBeVisible();
    await confirm.getByRole('button', { name: '移除' }).click();
    await expect(page.getByRole('alert')).toContainText('至少保留一名管理员', { timeout: 10000 });

    // 变更角色：developer → admin
    await page.getByLabel(`变更 ${member.username} 的角色`).selectOption('admin');
    await expect(memberRow).toContainText('管理员', { timeout: 10000 });

    // developer 无成员管理入口
    const devPage = await newIsolatedPage(page);
    await loginViaUI(devPage, fixture.developer.username);
    await devPage.goto(`/tenants/${fixture.teamId}/members`);
    await expect(
      devPage.getByText('仅租户管理员可管理成员与角色（开发角色无入口）。'),
    ).toBeVisible({ timeout: 10000 });
    await devPage.context().close();
  });

  test('E2E-WS5 个人租户用户无工作区切换器（零感知）', async ({ page }) => {
    const personal = await createFrontUser(page);
    await loginViaUI(page, personal.username);
    await expect(page.locator(sidebar())).toBeVisible();
    await expect(page.getByTestId('workspace-switcher')).toHaveCount(0);
    await expect(page.getByRole('link', { name: '工作区管理' })).toHaveCount(0);
  });

  test('E2E-WS6 团队全局工作区 + developer：设置页只读收敛', async ({ page }) => {
    const fixture = await createTeamFixture(page);
    await loginViaUI(page, fixture.developer.username);
    await expect(page.getByTestId('workspace-switcher')).toBeVisible();
    await page.locator('#workspace-switcher-select').selectOption(fixture.globalWorkspaceId);
    await expect(page.locator('#workspace-switcher-select')).toHaveValue(fixture.globalWorkspaceId);

    await page.goto('/settings');
    const banner = page.getByTestId('workspace-context-banner');
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toContainText(fixture.teamName);
    await expect(banner).toContainText('全局工作区');
    await expect(page.getByTestId('workspace-readonly-badge')).toBeVisible();
    await expect(
      page.getByText('全局工作区对开发者只读，编辑入口已隐藏'),
    ).toBeVisible();
    await expect(
      page.getByText('全局工作区对开发者只读，不可修改 Commit 设置'),
    ).toBeVisible();
  });
});
