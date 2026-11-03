import { test, expect, type Page } from '@playwright/test';
import {
  adminGqlRequest,
  adminLoginApi,
  createFrontUser,
  loginViaUI,
  startMockLlmServer,
} from './helpers';

/**
 * 多租户二期工作区 E2E（计划 Phase 10 / E2E-WS）。
 *
 * 覆盖：
 * - 切换器按租户分组/按角色过滤 + 本地持久化（refresh 后恢复）；
 * - 工作区管理页仅 team admin 可操作，developer 只读提示；
 * - 租户成员管理页：搜索添加 / 指定角色 / 变更角色 / last-admin 提示 / developer 无入口；
 * - 个人租户用户无切换器（零感知）；
 * - 团队全局工作区 + developer：设置页只读收敛（Commit 设置为成员级，不受工作区只读约束）。
 *
 * 数据经 admin-api（adminCreateTeamTenant / adminAddTenantMember）+ agent-api GraphQL 准备，
 * 需要 INTERNAL_API_TOKEN 或 MONGODB_URI（开户 helper 口径）。
 */

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const FRONT_WEB_URL = process.env.BASE_URL || 'http://localhost:35273';
const sidebar = () => 'nav[aria-label="Sidebar"]';
/** 设置页「Git」区块（成员级提交人设置，与工作区只读无关）。 */
const gitSectionFor = (page: Page) => page.locator('#git-section');

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
    // Commit 设置已收敛为成员级：只读工作区不再禁写（旧文案「不可修改 Commit 设置」下线）
    await expect(
      page.getByText('全局工作区对开发者只读，不可修改 Commit 设置'),
    ).toHaveCount(0);
    await expect(gitSectionFor(page).getByText('仅对云电脑环境生效')).toBeVisible();
    await expect(
      gitSectionFor(page).getByRole('button', { name: '保存 Git 设置' }),
    ).toBeEnabled();
  });

  test('E2E-WS2b 工作区改名 / 非空删除拦截 / 成员添加移除', async ({ page }) => {
    const fixture = await createTeamFixture(page);
    await loginViaUI(page, fixture.owner.username);
    await page.locator('#workspace-switcher-select').selectOption(fixture.globalWorkspaceId);
    await expect(page.locator('#workspace-switcher-select')).toHaveValue(fixture.globalWorkspaceId);
    await page.goto('/workspaces');
    await expect(page).toHaveURL(/\/workspaces$/);

    const row = page.getByTestId(`workspace-row-${fixture.normalWorkspaceId}`);
    await expect(row).toBeVisible({ timeout: 15000 });

    // 1) 改名
    const renamed = `renamed-${Date.now().toString(36)}`;
    await row.getByRole('button', { name: '改名' }).click();
    const renameDialog = page.getByRole('dialog');
    await expect(renameDialog.getByText('重命名工作区')).toBeVisible();
    await renameDialog.getByLabel('工作区名称').fill(renamed);
    await renameDialog.getByRole('button', { name: '保存' }).click();
    await expect(
      page.getByRole('list', { name: '工作区列表' }).getByText(renamed),
    ).toBeVisible({ timeout: 15000 });

    // 2) 成员添加 / 移除（developer 已是租户成员，但尚未加入该普通工作区）
    await row.getByRole('button', { name: '成员' }).click();
    const membersDialog = page.getByRole('dialog');
    await expect(membersDialog.getByText('工作区成员')).toBeVisible();
    await membersDialog.getByLabel('选择本租户成员').selectOption(fixture.developer.userId);
    await membersDialog.getByRole('button', { name: '添加' }).click();

    const memberList = membersDialog.getByRole('list', { name: '工作区成员列表' });
    const memberRow = memberList.locator('li').filter({ hasText: `@${fixture.developer.username}` });
    await expect(memberRow).toHaveCount(1, { timeout: 15000 });

    await memberRow.getByRole('button', { name: '移除' }).click();
    await expect(
      memberList.locator('li').filter({ hasText: `@${fixture.developer.username}` }),
    ).toHaveCount(0, { timeout: 15000 });
    await membersDialog.getByRole('button', { name: '关闭' }).click();

    // 3) 非空删除拦截：在本工作区写入供应商（工作区资源）后删除被拒
    //    Commit 设置已收敛为成员级、不再计入工作区资源，故改用供应商构造「非空」。
    const mock = await startMockLlmServer();
    try {
      const providerName = `non-empty-${Date.now().toString(36)}`;
      const providerSaved = await gqlAs(
        page,
        `mutation CreateProvider($input: ProviderInput!) {
          createProvider(input: $input) { id name workspaceId scope }
        }`,
        {
          input: {
            name: providerName,
            type: 'OpenAI',
            endpoint: `http://127.0.0.1:${mock.port}/v1`,
            credentialType: 'api_key',
            credentialValue: 'sk-e2e-non-empty',
          },
        },
        fixture.owner.token,
        fixture.normalWorkspaceId,
      );
      expect(providerSaved.errors, JSON.stringify(providerSaved.errors)).toBeUndefined();
      expect(providerSaved.data!.createProvider.workspaceId).toBe(fixture.normalWorkspaceId);

      await row.getByRole('button', { name: '删除' }).click();
      const confirm = page.getByRole('dialog');
      await expect(confirm.getByText('删除工作区')).toBeVisible();
      await confirm.getByRole('button', { name: '删除' }).click();
      await expect(
        page.getByText('工作区非空（仍持有资源），无法删除'),
      ).toBeVisible({ timeout: 15000 });
      // 工作区保留，未被删除
      await expect(page.getByTestId(`workspace-row-${fixture.normalWorkspaceId}`)).toBeVisible();
    } finally {
      await mock.close();
    }
  });

  test('E2E-WS3b 资源来源徽标：全局工作区资源 / 本工作区资源', async ({ page }) => {
    const fixture = await createTeamFixture(page);
    const mock = await startMockLlmServer();
    try {
      const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const globalProviderName = `badge-global-${suffix}`;
      const localProviderName = `badge-local-${suffix}`;
      const createProvider = `
        mutation CreateProvider($input: ProviderInput!) {
          createProvider(input: $input) { id name workspaceId scope }
        }
      `;
      const providerInput = (name: string) => ({
        name,
        type: 'OpenAI',
        endpoint: `http://127.0.0.1:${mock.port}/v1`,
        credentialType: 'api_key',
        credentialValue: 'sk-e2e-badge',
      });

      const globalProvider = await gqlAs(
        page,
        createProvider,
        { input: providerInput(globalProviderName) },
        fixture.owner.token,
        fixture.globalWorkspaceId,
      );
      expect(globalProvider.errors, JSON.stringify(globalProvider.errors)).toBeUndefined();

      const localProvider = await gqlAs(
        page,
        createProvider,
        { input: providerInput(localProviderName) },
        fixture.owner.token,
        fixture.normalWorkspaceId,
      );
      expect(localProvider.errors, JSON.stringify(localProvider.errors)).toBeUndefined();

      await loginViaUI(page, fixture.owner.username);
      await page.locator('#workspace-switcher-select').selectOption(fixture.normalWorkspaceId);
      await expect(page.locator('#workspace-switcher-select')).toHaveValue(fixture.normalWorkspaceId);
      await page.goto('/settings');

      const globalItem = page.getByText(globalProviderName, { exact: true }).first().locator('..');
      await expect(globalItem.getByTestId('resource-source-badge')).toHaveText('全局工作区', {
        timeout: 15000,
      });
      const localItem = page.getByText(localProviderName, { exact: true }).first().locator('..');
      await expect(localItem.getByTestId('resource-source-badge')).toHaveText('本工作区');
    } finally {
      await mock.close();
    }
  });

  test('E2E-WS4b 成员级 Commit 设置：任一工作区保存后切到其他工作区回显一致（无三段继承）', async ({
    page,
  }) => {
    const fixture = await createTeamFixture(page);
    const settingsInput = {
      committerType: 'CUSTOM',
      customName: 'Member Committer E2E',
      customEmail: 'member-committer-e2e@example.com',
    };

    const saved = await gqlAs(
      page,
      `mutation UpdateCommitSettings($input: CommitSettingsInput!) {
        updateCommitSettings(input: $input) { committerType customName customEmail }
      }`,
      { input: settingsInput },
      fixture.owner.token,
      fixture.normalWorkspaceId,
    );
    expect(saved.errors, JSON.stringify(saved.errors)).toBeUndefined();
    expect(saved.data!.updateCommitSettings).toEqual(settingsInput);

    await loginViaUI(page, fixture.owner.username);

    const expectEcho = async () => {
      const git = gitSectionFor(page);
      await expect(
        git.getByRole('radiogroup', { name: '提交人' }).getByRole('radio', { name: '自定义' }),
      ).toBeChecked({ timeout: 15000 });
      await expect(git.getByLabel('用户名')).toHaveValue(settingsInput.customName);
      await expect(git.getByLabel('邮箱')).toHaveValue(settingsInput.customEmail);
    };

    // ① 保存所在的工作区：回显本成员设置
    await page.locator('#workspace-switcher-select').selectOption(fixture.normalWorkspaceId);
    await expect(page.locator('#workspace-switcher-select')).toHaveValue(fixture.normalWorkspaceId);
    await page.goto('/settings');
    await expectEcho();

    // ② 切到团队全局工作区：仍是同一份成员设置（不存在「继承自全局工作区 / 本工作区」三段语义）
    await page.locator('#workspace-switcher-select').selectOption(fixture.globalWorkspaceId);
    await expect(page.locator('#workspace-switcher-select')).toHaveValue(fixture.globalWorkspaceId);
    await page.goto('/settings');
    await expectEcho();
    await expect(page.getByTestId('commit-settings-source')).toHaveCount(0);
  });
});
