import { test, expect, type Page } from '@playwright/test';
import {
  adminGqlRequest,
  adminLoginApi,
  adminLoginViaUI,
  createFrontUser,
  loginViaUI,
  startMockLlmServer,
} from './helpers';

/**
 * 后台 team 租户管理 E2E（计划 Phase 10 / E2E-TT）。
 *
 * 覆盖：
 * - E2E-TT1：后台 UI 创建团队租户 → 租户详情添加成员并指定角色 → 成员前台登录即见团队空间
 *   （切换器出现团队租户分组；admin 角色可见工作区/成员管理入口）；
 * - E2E-TT2：成员登录协作 —— owner 创建的普通工作区与其中资源（供应商）对成员可见；
 * - E2E-TT3：团队计费口径 —— 团队工作区「我的费用」取 team 租户余额，切回个人工作区余额不变。
 *
 * 需要 admin-web / admin-api / agent-api / agent-web 就绪；开户 helper 依赖
 * INTERNAL_API_TOKEN 或 MONGODB_URI；E2E-TT3 依赖 admin-api 计费服务（需 Aspire 全量服务）。
 */

const sidebar = () => 'nav[aria-label="Sidebar"]';
const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';

const CREATE_TEAM_TENANT = `
  mutation CreateTeamTenant($name: String!) {
    adminCreateTeamTenant(name: $name) { id name type memberCount }
  }
`;

const TENANT_DETAIL = `
  query Tenant($id: ID!) {
    adminTenant(id: $id) { id workspaces { id name type } }
  }
`;

const ADD_TENANT_MEMBER = `
  mutation AddTenantMember($tenantId: ID!, $username: String!, $role: TenantRole) {
    adminAddTenantMember(tenantId: $tenantId, username: $username, role: $role) {
      id username role
    }
  }
`;

const CREATE_TENANT_WORKSPACE = `
  mutation CreateTenantWorkspace($name: String!) {
    createTenantWorkspace(name: $name) { id name type }
  }
`;

const ADD_TENANT_WORKSPACE_MEMBER = `
  mutation AddWorkspaceMember($workspaceId: ID!, $userId: ID!) {
    addTenantWorkspaceMember(workspaceId: $workspaceId, userId: $userId) {
      id memberCount
    }
  }
`;

const CREATE_PROVIDER = `
  mutation CreateProvider($input: ProviderInput!) {
    createProvider(input: $input) { id name workspaceId scope }
  }
`;

const MY_WORKSPACES = `
  query MyWorkspaces {
    myWorkspaces { id name type tenant { id name type } }
  }
`;

const BILLING_ACCOUNTS_BY_OWNER = `
  query BillingAccountsByOwner($keyword: String, $ownerType: BillingOwnerType) {
    adminBillingAccounts(keyword: $keyword, ownerType: $ownerType) {
      id ownerType ownerId ownerName availableBalance
    }
  }
`;

const RECHARGE = `
  mutation Recharge($id: ID!, $amount: Float!, $note: String) {
    rechargeBillingAccount(accountId: $id, amount: $amount, note: $note) {
      id amount balanceAfter
    }
  }
`;

async function adminGqlAs<T = any>(
  page: Page,
  query: string,
  variables: Record<string, unknown> | undefined,
  token: string,
): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  const res = await adminGqlRequest(page, query, variables, token);
  return (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
}

async function agentGqlAs<T = any>(
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

interface TeamFixture {
  teamId: string;
  teamName: string;
  globalWorkspaceId: string;
}

/** 后台 API 建 team 租户并加成员（owner=admin，member=developer），返回团队全局工作区。 */
async function createTeamFixture(
  page: Page,
  member: { username: string },
  extraMembers: Array<{ username: string; role: 'admin' | 'developer' }> = [],
): Promise<TeamFixture> {
  const adminToken = await adminLoginApi(page);
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const teamName = `e2e-tt-${suffix}`.slice(0, 60);

  const created = await adminGqlAs<{ adminCreateTeamTenant: { id: string } }>(
    page,
    CREATE_TEAM_TENANT,
    { name: teamName },
    adminToken,
  );
  expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
  const teamId = created.data!.adminCreateTeamTenant.id;

  const detail = await adminGqlAs<{
    adminTenant: { workspaces: Array<{ id: string; name: string; type: string }> } | null;
  }>(page, TENANT_DETAIL, { id: teamId }, adminToken);
  expect(detail.errors, JSON.stringify(detail.errors)).toBeUndefined();
  const globalWorkspace = detail.data!.adminTenant!.workspaces.find(
    (workspace) => workspace.type === 'global',
  );
  expect(globalWorkspace, 'team 租户应自动开通全局工作区').toBeTruthy();

  for (const [username, role] of [
    [member.username, 'admin'],
    ...extraMembers.map((row) => [row.username, row.role] as const),
  ] as const) {
    const added = await adminGqlAs(page, ADD_TENANT_MEMBER, { tenantId: teamId, username, role }, adminToken);
    expect(added.errors, JSON.stringify(added.errors)).toBeUndefined();
  }

  return { teamId, teamName, globalWorkspaceId: globalWorkspace!.id };
}

test.describe('Admin Team Tenant E2E（E2E-TT）', () => {
  test('E2E-TT1 后台创建 team 租户 + 加成员，成员登录见团队空间', async ({ page }) => {
    const member = await createFrontUser(page, { prefix: 'ttm' });
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
    const teamName = `e2e-team-${suffix}`.slice(0, 60);

    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /租户管理/ }).click();
    await expect(page).toHaveURL(/\/tenants/);

    // 创建团队租户
    await page.getByRole('button', { name: '创建团队租户' }).click();
    const createDialog = page.getByRole('dialog');
    await expect(createDialog).toBeVisible();
    await createDialog.locator('#team-tenant-name').fill(teamName);
    await createDialog.getByRole('button', { name: '确认创建' }).click();
    await expect(createDialog).toBeHidden({ timeout: 15000 });

    // 列表检索命中，类型为团队
    await page.getByRole('textbox', { name: '租户名称检索' }).fill(teamName);
    const row = page.locator('tbody tr').filter({ hasText: teamName }).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row).toContainText('团队');
    await row.click();
    await expect(page).toHaveURL(/\/tenants\/[^/]+$/);

    // 详情：自动开通全局工作区（只读视图）
    await expect(page.getByRole('heading', { name: teamName })).toBeVisible();
    await expect(page.getByRole('heading', { name: '工作区（只读）' })).toBeVisible();
    await expect(page.getByText('全局工作区').first()).toBeVisible();

    // 添加成员并指定管理员角色
    await page.getByRole('button', { name: '添加成员' }).click();
    const memberDialog = page.getByRole('dialog');
    await expect(memberDialog).toBeVisible();
    await memberDialog.locator('#tenant-member-username').fill(member.username);
    await memberDialog.locator('#tenant-member-role').selectOption('admin');
    await memberDialog.getByRole('button', { name: '确认添加' }).click();
    await expect(memberDialog).toBeHidden({ timeout: 15000 });

    const memberRow = page.locator('tbody tr').filter({ hasText: member.username }).first();
    await expect(memberRow).toBeVisible({ timeout: 15000 });
    await expect(memberRow).toContainText('管理员');

    // 成员前台登录：切换器出现团队租户；admin 角色可见管理入口
    await loginViaUI(page, member.username);
    await expect(page.locator(sidebar())).toBeVisible();
    await expect(page.getByTestId('workspace-switcher')).toBeVisible();

    // 切换器按租户分组：optgroup label 含团队名与角色，组内为团队工作区
    const teamGroup = page.locator(`#workspace-switcher-select optgroup[label*="${teamName}"]`);
    await expect(teamGroup).toHaveCount(1);
    expect(await teamGroup.getAttribute('label')).toContain('管理员');
    const teamOptions = await teamGroup.locator('option').allTextContents();
    expect(teamOptions.some((text) => text.includes('（全局）'))).toBe(true);

    const value = await teamGroup.locator('option').first().getAttribute('value');
    expect(value).toBeTruthy();
    await page.locator('#workspace-switcher-select').selectOption(value!);

    await expect(page.getByRole('link', { name: '工作区管理' })).toBeVisible();
    await expect(page.getByRole('link', { name: '租户成员' })).toBeVisible();
  });

  test('E2E-TT2 成员登录协作：owner 创建的普通工作区与资源对成员可见', async ({ page }) => {
    const owner = await createFrontUser(page, { prefix: 'tto2' });
    const member = await createFrontUser(page, { prefix: 'ttm2' });
    const fixture = await createTeamFixture(page, owner, [{ username: member.username, role: 'developer' }]);

    // owner 在团队全局工作区创建普通工作区，并把 developer 加入
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const normal = await agentGqlAs<{ createTenantWorkspace: { id: string; name: string } }>(
      page,
      CREATE_TENANT_WORKSPACE,
      { name: `collab-${suffix}` },
      owner.token,
      fixture.globalWorkspaceId,
    );
    expect(normal.errors, JSON.stringify(normal.errors)).toBeUndefined();
    const normalWorkspaceId = normal.data!.createTenantWorkspace.id;

    const joined = await agentGqlAs(
      page,
      ADD_TENANT_WORKSPACE_MEMBER,
      { workspaceId: normalWorkspaceId, userId: member.userId },
      owner.token,
      fixture.globalWorkspaceId,
    );
    expect(joined.errors, JSON.stringify(joined.errors)).toBeUndefined();

    // owner 在普通工作区写入共享资源（供应商；mock LLM 仅用于连通性校验）
    const mock = await startMockLlmServer();
    try {
      const providerName = `collab-provider-${suffix}`;
      const provider = await agentGqlAs(
        page,
        CREATE_PROVIDER,
        {
          input: {
            name: providerName,
            type: 'OpenAI',
            endpoint: `http://127.0.0.1:${mock.port}/v1`,
            credentialType: 'api_key',
            credentialValue: 'sk-e2e-collab',
          },
        },
        owner.token,
        normalWorkspaceId,
      );
      expect(provider.errors, JSON.stringify(provider.errors)).toBeUndefined();

      // 成员登录：切换器出现该普通工作区，设置页可见 owner 创建的供应商
      await loginViaUI(page, member.username);
      await expect(page.getByTestId('workspace-switcher')).toBeVisible();
      const option = page.locator(`#workspace-switcher-select option[value="${normalWorkspaceId}"]`);
      await expect(option).toHaveCount(1);
      await page.locator('#workspace-switcher-select').selectOption(normalWorkspaceId);
      await expect(page.locator('#workspace-switcher-select')).toHaveValue(normalWorkspaceId);

      await page.goto('/settings');
      const providerItem = page.getByText(providerName, { exact: true }).locator('..');
      await expect(providerItem).toBeVisible({ timeout: 15000 });
      await expect(providerItem.getByTestId('resource-source-badge')).toHaveText('本工作区');
    } finally {
      await mock.close();
    }
  });

  /**
   * E2E-TT3 团队计费口径（最小断言，需 Aspire admin-api 计费服务）。
   *
   * 真实「成员在团队工作区创建云电脑 → 扣 team 租户」依赖 HARNESS_ENABLED 与可用余额
   * （扣费/报价链路已由 tests/api `cloud-host-charges` / `cloud-host-billing-quote` / `T-B2` 覆盖）。
   * 本用例只断言 UI 计费归属：团队工作区「我的费用」= team 租户余额，个人工作区余额不变。
   */
  test('E2E-TT3 团队计费口径：团队工作区余额取 team 租户，个人余额不变', async ({ page }) => {
    const owner = await createFrontUser(page, { prefix: 'ttb3' });
    const fixture = await createTeamFixture(page, owner);
    const adminToken = await adminLoginApi(page);

    // team 租户计费账户充值 10 credits
    const accounts = await adminGqlAs<{
      adminBillingAccounts: Array<{ id: string; ownerId: string; availableBalance: number }>;
    }>(
      page,
      BILLING_ACCOUNTS_BY_OWNER,
      { keyword: fixture.teamName, ownerType: 'tenant' },
      adminToken,
    );
    expect(accounts.errors, JSON.stringify(accounts.errors)).toBeUndefined();
    const teamAccount = accounts.data!.adminBillingAccounts.find(
      (account) => account.ownerId === fixture.teamId,
    );
    expect(teamAccount, 'team 租户应有 tenant 计费账户').toBeDefined();

    const recharge = await adminGqlAs(
      page,
      RECHARGE,
      { id: teamAccount!.id, amount: 10, note: 'team billing e2e' },
      adminToken,
    );
    expect(recharge.errors, JSON.stringify(recharge.errors)).toBeUndefined();

    // 个人全局工作区（切回后验证个人余额不变）
    const workspaces = await agentGqlAs<{
      myWorkspaces: Array<{ id: string; type: string; tenant: { id: string } }>;
    }>(page, MY_WORKSPACES, undefined, owner.token);
    expect(workspaces.errors, JSON.stringify(workspaces.errors)).toBeUndefined();
    const personalGlobal = workspaces.data!.myWorkspaces.find(
      (workspace) => workspace.tenant.id === owner.userId,
    );
    expect(personalGlobal, '个人租户全局工作区应存在').toBeTruthy();

    await loginViaUI(page, owner.username);
    await page.locator('#workspace-switcher-select').selectOption(fixture.globalWorkspaceId);
    await expect(page.locator('#workspace-switcher-select')).toHaveValue(fixture.globalWorkspaceId);

    await page.goto('/billing');
    await expect(page.getByText('可用余额').first().locator('..')).toContainText('10.00', {
      timeout: 15000,
    });

    // 切回个人工作区：余额仍为 0，未被团队扣费污染
    await page.locator('#workspace-switcher-select').selectOption(personalGlobal!.id);
    await expect(page.locator('#workspace-switcher-select')).toHaveValue(personalGlobal!.id);
    await page.goto('/billing');
    await expect(page.getByText('可用余额').first().locator('..')).toContainText('0.00', {
      timeout: 15000,
    });
  });
});
