/**
 * 后台 team 租户开通与成员初始化 API（多租户二期 Phase 6/10，`contracts/admin-tenant.graphql`）。
 *
 * 覆盖 T-TT-API：
 * - adminCreateTeamTenant（含重名 409 `tenant name already exists`）；
 * - adminAddTenantMember 指定角色 / 缺省 developer / 重复幂等不覆盖角色；
 * - adminTenant 详情成员 role（经 tenantmembers 展开）与只读 workspaces（global 成员数=租户成员数）；
 * - adminRemoveTenantMember（last-admin 409；成功后成员登录立即失效）；
 * - personal 租户成员写操作全拒绝。
 *
 * 需要 admin-api + agent-api 就绪、`INTERNAL_API_TOKEN`（admin-api 侧转发）与管理员口令归一化。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { adminGql, ensureAdminLogin } from './helpers.js';
import { loginFrontUser, uniqueFrontUsername } from '../support/front-users.js';

const AGENT_GRAPHQL = process.env.API_URL || 'http://localhost:10001/graphql';

const CREATE_FRONT_USER = `
  mutation CreateFrontUser($username: String!, $password: String!) {
    adminCreateFrontUser(username: $username, password: $password) { id name username }
  }
`;

const CREATE_TEAM_TENANT = `
  mutation CreateTeamTenant($name: String!) {
    adminCreateTeamTenant(name: $name) { id name type memberCount balance createdAt }
  }
`;

const ADD_TENANT_MEMBER = `
  mutation AddTenantMember($tenantId: ID!, $username: String!, $role: TenantRole) {
    adminAddTenantMember(tenantId: $tenantId, username: $username, role: $role) {
      id name username role createdAt
    }
  }
`;

const REMOVE_TENANT_MEMBER = `
  mutation RemoveTenantMember($tenantId: ID!, $userId: ID!) {
    adminRemoveTenantMember(tenantId: $tenantId, userId: $userId)
  }
`;

const TENANT_DETAIL = `
  query Tenant($id: ID!) {
    adminTenant(id: $id) {
      id name type createdAt
      users { id name username role createdAt }
      workspaces { id name type memberCount createdAt }
    }
  }
`;

const MY_WORKSPACES = `
  query MyWorkspaces {
    myWorkspaces {
      id name type
      tenant { id name type }
    }
  }
`;

const MODELS = `query Models { models { id name } }`;

const CLOUD_HOST_QUOTE = `
  query CloudHostBillingQuote {
    cloudHostBillingQuote { createCredits perMinuteCredits availableBalance }
  }
`;

const ADMIN_HTTP = (process.env.ADMIN_API_URL || 'http://localhost:10003/graphql').replace(
  /\/graphql\/?$/,
  '',
);

const BILLING_ACCOUNTS_BY_OWNER = `
  query BillingAccountsByOwner($keyword: String, $ownerType: BillingOwnerType) {
    adminBillingAccounts(keyword: $keyword, ownerType: $ownerType) {
      id ownerType ownerId ownerName availableBalance cashBalance status
    }
  }
`;

const RECHARGE = `
  mutation Recharge($id: ID!, $amount: Float!, $note: String) {
    rechargeBillingAccount(accountId: $id, amount: $amount, note: $note) {
      id amount balanceAfter type
    }
  }
`;


function agentGql(
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
  workspaceId?: string,
): Promise<{ data?: any; errors?: Array<{ message: string }> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (workspaceId) headers['x-workspace-id'] = workspaceId;
  return fetch(AGENT_GRAPHQL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  }).then((res) => res.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>);
}

describe('Admin Team Tenant API（T-TT-API）', () => {
  let token = '';
  const password = 'password123';
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const teamName = `tt-${suffix}`.slice(0, 60);
  const ownerUsername = uniqueFrontUsername('tto');
  const devUsername = uniqueFrontUsername('ttd');

  let teamId = '';
  let teamGlobalWorkspaceId = '';
  let owner: { id: string; name: string; username: string };
  let dev: { id: string; name: string; username: string };

  beforeAll(async () => {
    token = await ensureAdminLogin();

    const ownerCreated = await adminGql<{ adminCreateFrontUser: typeof owner }>(
      CREATE_FRONT_USER,
      { username: ownerUsername, password },
      token,
    );
    expect(ownerCreated.errors, JSON.stringify(ownerCreated.errors)).toBeUndefined();
    owner = ownerCreated.data!.adminCreateFrontUser;

    const devCreated = await adminGql<{ adminCreateFrontUser: typeof dev }>(
      CREATE_FRONT_USER,
      { username: devUsername, password },
      token,
    );
    expect(devCreated.errors, JSON.stringify(devCreated.errors)).toBeUndefined();
    dev = devCreated.data!.adminCreateFrontUser;
  });

  it('T-TT-API1: 三个 team mutation 未鉴权一律 Not authenticated', async () => {
    for (const [query, variables] of [
      [CREATE_TEAM_TENANT, { name: teamName }],
      [ADD_TENANT_MEMBER, { tenantId: '000000000000000000000000', username: ownerUsername }],
      [REMOVE_TENANT_MEMBER, { tenantId: '000000000000000000000000', userId: owner.id }],
    ] as const) {
      const res = await adminGql(query, variables as Record<string, unknown>);
      expect(res.errors?.[0]?.message).toBe('Not authenticated');
    }
  });

  it('T-TT-API2: 创建 team 租户（零成员 / 零余额）→ 重名 409', async () => {
    const created = await adminGql<{
      adminCreateTeamTenant: { id: string; name: string; type: string; memberCount: number; balance: number | null };
    }>(CREATE_TEAM_TENANT, { name: teamName }, token);
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    const team = created.data!.adminCreateTeamTenant;
    expect(team).toMatchObject({ name: teamName, type: 'team', memberCount: 0 });
    expect(team.balance === 0 || team.balance === null).toBe(true);
    teamId = team.id;

    const duplicate = await adminGql(CREATE_TEAM_TENANT, { name: teamName }, token);
    expect(duplicate.errors?.[0]?.message).toBe('tenant name already exists');
    expect(duplicate.errors?.[0]?.extensions?.code).toBe('CONFLICT');

    // 重名不产生第二条同名租户
    const list = await adminGql<{ adminTenants: Array<{ id: string; name: string }> }>(
      `query Tenants($keyword: String) { adminTenants(keyword: $keyword) { id name } }`,
      { keyword: teamName },
      token,
    );
    expect(list.errors).toBeUndefined();
    expect(list.data!.adminTenants.filter((tenant) => tenant.name === teamName)).toHaveLength(1);
  });

  it('T-TT-API3: 加成员指定角色 / 缺省 developer / 重复幂等不覆盖角色', async () => {
    const adminMember = await adminGql<{ adminAddTenantMember: { id: string; username: string; role: string } }>(
      ADD_TENANT_MEMBER,
      { tenantId: teamId, username: ownerUsername, role: 'admin' },
      token,
    );
    expect(adminMember.errors, JSON.stringify(adminMember.errors)).toBeUndefined();
    expect(adminMember.data!.adminAddTenantMember).toMatchObject({
      id: owner.id,
      username: ownerUsername,
      role: 'admin',
    });

    const devMember = await adminGql<{ adminAddTenantMember: { id: string; username: string; role: string } }>(
      ADD_TENANT_MEMBER,
      { tenantId: teamId, username: devUsername },
      token,
    );
    expect(devMember.errors, JSON.stringify(devMember.errors)).toBeUndefined();
    expect(devMember.data!.adminAddTenantMember).toMatchObject({
      id: dev.id,
      username: devUsername,
      role: 'developer',
    });

    // 重复添加：幂等返回既有角色，不被 role=admin 覆盖
    const again = await adminGql<{ adminAddTenantMember: { role: string } }>(
      ADD_TENANT_MEMBER,
      { tenantId: teamId, username: devUsername, role: 'admin' },
      token,
    );
    expect(again.errors, JSON.stringify(again.errors)).toBeUndefined();
    expect(again.data!.adminAddTenantMember.role).toBe('developer');
  });

  it('T-TT-API4: adminTenant 详情含 role 与只读 workspaces（global 成员数=成员数）', async () => {
    const detail = await adminGql<{
      adminTenant: {
        id: string;
        type: string;
        users: Array<{ id: string; username: string; role: string }>;
        workspaces: Array<{ id: string; name: string; type: string; memberCount: number }>;
      } | null;
    }>(TENANT_DETAIL, { id: teamId }, token);
    expect(detail.errors, JSON.stringify(detail.errors)).toBeUndefined();
    const tenant = detail.data!.adminTenant!;
    expect(tenant.type).toBe('team');

    const ownerRow = tenant.users.find((user) => user.id === owner.id);
    const devRow = tenant.users.find((user) => user.id === dev.id);
    expect(ownerRow).toMatchObject({ username: ownerUsername, role: 'admin' });
    expect(devRow).toMatchObject({ username: devUsername, role: 'developer' });

    const globalWorkspace = tenant.workspaces.find((workspace) => workspace.type === 'global');
    expect(globalWorkspace, 'team 租户应自动开通全局工作区').toBeDefined();
    expect(globalWorkspace!.memberCount).toBe(tenant.users.length);
    teamGlobalWorkspaceId = globalWorkspace!.id;

    // 工作区只读：无工作区编辑/删除 mutation
    const schema = await adminGql<{
      __schema: { mutationType: { fields: Array<{ name: string }> } };
    }>(`query { __schema { mutationType { fields { name } } } }`, undefined, token);
    const mutationNames = schema.data!.__schema.mutationType.fields.map((field) => field.name);
    expect(mutationNames).toEqual(
      expect.arrayContaining(['adminCreateTeamTenant', 'adminAddTenantMember', 'adminRemoveTenantMember']),
    );
    expect(mutationNames.some((name) => /workspace/i.test(name))).toBe(false);
  });

  it('T-TT-API5: 成员登录即见团队空间；last-admin 移除 409；成功后成员立即失效', async () => {
    const login = await loginFrontUser(devUsername, password);
    const before = await agentGql(MY_WORKSPACES, undefined, login.token);
    expect(before.errors).toBeUndefined();
    const teamWorkspaces = before.data.myWorkspaces.filter(
      (workspace: { tenant: { id: string } }) => workspace.tenant.id === teamId,
    );
    expect(teamWorkspaces.length).toBeGreaterThan(0);
    expect(teamWorkspaces.some((workspace: { type: string }) => workspace.type === 'global')).toBe(true);

    // 当前唯一 admin 是 owner：不能移除
    const lastAdmin = await adminGql(
      REMOVE_TENANT_MEMBER,
      { tenantId: teamId, userId: owner.id },
      token,
    );
    expect(lastAdmin.errors?.[0]?.message).toBe('last admin cannot be removed');
    expect(lastAdmin.errors?.[0]?.extensions?.code).toBe('CONFLICT');

    const removed = await adminGql<{ adminRemoveTenantMember: boolean }>(
      REMOVE_TENANT_MEMBER,
      { tenantId: teamId, userId: dev.id },
      token,
    );
    expect(removed.errors, JSON.stringify(removed.errors)).toBeUndefined();
    expect(removed.data!.adminRemoveTenantMember).toBe(true);

    const detail = await adminGql<{ adminTenant: { users: Array<{ id: string }> } | null }>(
      TENANT_DETAIL,
      { id: teamId },
      token,
    );
    expect(detail.data!.adminTenant!.users.some((user) => user.id === dev.id)).toBe(false);

    // 移出后立即失效：myWorkspaces 不含团队；显式 header 访问团队全局工作区 → workspace not found
    const after = await agentGql(MY_WORKSPACES, undefined, login.token);
    expect(
      after.data.myWorkspaces.some(
        (workspace: { tenant: { id: string } }) => workspace.tenant.id === teamId,
      ),
    ).toBe(false);
    const blocked = await agentGql(MODELS, undefined, login.token, teamGlobalWorkspaceId);
    expect(blocked.errors?.[0]?.message).toBe('workspace not found');
  });

  it('T-TT-API6: personal 租户成员写操作全拒绝', async () => {
    const ownerLogin = await loginFrontUser(ownerUsername, password);
    const personalTenantId = ownerLogin.user.tenant.id;
    expect(ownerLogin.user.tenant.type).toBe('personal');

    const add = await adminGql(
      ADD_TENANT_MEMBER,
      { tenantId: personalTenantId, username: devUsername },
      token,
    );
    expect(add.errors?.[0]?.message).toBe('personal tenant is immutable');
    expect(add.errors?.[0]?.extensions?.code).toBe('INVALID_ARGUMENT');

    const remove = await adminGql(
      REMOVE_TENANT_MEMBER,
      { tenantId: personalTenantId, userId: owner.id },
      token,
    );
    expect(remove.errors?.[0]?.message).toBe('personal tenant is immutable');
    expect(remove.errors?.[0]?.extensions?.code).toBe('INVALID_ARGUMENT');
  });

  /**
   * T-B2 团队计费口径（最小断言，需 Aspire 全量服务：admin-api billing + agent-api）。
   *
   * 真实「在团队工作区创建云电脑 → 扣创建费 → 按分钟计费」依赖 HARNESS_ENABLED 与 RUNNING
   * 容器（`cloud-host-charges.test.ts` + `cloud-host-billing-quote.test.ts` 已覆盖扣费/退款/报价链路）。
   * 本用例断言计费归属：团队工作区上下文的报价/扣费使用 **team 租户**账户，个人租户余额不变。
   */
  it.skipIf(!process.env.INTERNAL_API_TOKEN)(
    'T-B2: 团队工作区计费口径 —— 充值/扣费落 team 租户，个人余额不变（需 Aspire）',
    async () => {
      const billingOwnerName = uniqueFrontUsername('ttb');
      const createdUser = await adminGql<{ adminCreateFrontUser: { id: string; username: string } }>(
        CREATE_FRONT_USER,
        { username: billingOwnerName, password },
        token,
      );
      expect(createdUser.errors, JSON.stringify(createdUser.errors)).toBeUndefined();

      const billingTeamName = `tb-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`.slice(0, 60);
      const createdTeam = await adminGql<{ adminCreateTeamTenant: { id: string; name: string } }>(
        CREATE_TEAM_TENANT,
        { name: billingTeamName },
        token,
      );
      expect(createdTeam.errors, JSON.stringify(createdTeam.errors)).toBeUndefined();
      const billingTeamId = createdTeam.data!.adminCreateTeamTenant.id;

      const added = await adminGql(
        ADD_TENANT_MEMBER,
        { tenantId: billingTeamId, username: billingOwnerName, role: 'admin' },
        token,
      );
      expect(added.errors, JSON.stringify(added.errors)).toBeUndefined();

      const login = await loginFrontUser(billingOwnerName, password);
      const workspaces = await agentGql(MY_WORKSPACES, undefined, login.token);
      expect(workspaces.errors, JSON.stringify(workspaces.errors)).toBeUndefined();
      const teamGlobal = workspaces.data!.myWorkspaces.find(
        (workspace: { type: string; tenant: { id: string } }) =>
          workspace.tenant.id === billingTeamId && workspace.type === 'global',
      );
      expect(teamGlobal, 'team 租户应自动开通全局工作区').toBeDefined();

      // team 租户计费账户（adminCreateTeamTenant 时创建，零余额）与个人租户账户
      const teamAccounts = await adminGql<{
        adminBillingAccounts: Array<{ id: string; ownerId: string; availableBalance: number }>;
      }>(BILLING_ACCOUNTS_BY_OWNER, { keyword: billingTeamName, ownerType: 'tenant' }, token);
      expect(teamAccounts.errors, JSON.stringify(teamAccounts.errors)).toBeUndefined();
      const teamAccount = teamAccounts.data!.adminBillingAccounts.find(
        (account) => account.ownerId === billingTeamId,
      );
      expect(teamAccount, 'team 租户应有 tenant 计费账户').toBeDefined();

      const personalAccounts = await adminGql<{
        adminBillingAccounts: Array<{ id: string; ownerId: string; availableBalance: number }>;
      }>(BILLING_ACCOUNTS_BY_OWNER, { keyword: billingOwnerName, ownerType: 'tenant' }, token);
      const personalAccount = personalAccounts.data!.adminBillingAccounts.find(
        (account) => account.ownerId === login.user.id,
      );
      expect(personalAccount, '成员应有个人 tenant 计费账户').toBeDefined();
      expect(personalAccount!.availableBalance).toBe(0);

      // 充值到 team 租户：团队上下文报价可见，个人上下文仍为零
      const recharge = await adminGql<{
        rechargeBillingAccount: { amount: number; balanceAfter: number };
      }>(RECHARGE, { id: teamAccount!.id, amount: 10, note: 'team billing caliber' }, token);
      expect(recharge.errors, JSON.stringify(recharge.errors)).toBeUndefined();
      expect(recharge.data!.rechargeBillingAccount.balanceAfter).toBe(10);

      const teamQuote = await agentGql(CLOUD_HOST_QUOTE, undefined, login.token, teamGlobal!.id);
      expect(teamQuote.errors, JSON.stringify(teamQuote.errors)).toBeUndefined();
      expect(teamQuote.data!.cloudHostBillingQuote.availableBalance).toBe(10);

      const personalQuote = await agentGql(CLOUD_HOST_QUOTE, undefined, login.token);
      expect(personalQuote.errors, JSON.stringify(personalQuote.errors)).toBeUndefined();
      expect(personalQuote.data!.cloudHostBillingQuote.availableBalance).toBe(0);

      // 消费（等价「创建云电脑一次性扣费」）：扣 team 租户账户，个人账户不变
      const charge = await fetch(`${ADMIN_HTTP}/internal/billing/charges`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}`,
        },
        body: JSON.stringify({
          accountId: teamAccount!.id,
          productId: 'cloud_host.create',
          quantity: 1,
          idempotentKey: `cloud_host.create:team:${teamAccount!.id}:${Date.now()}`,
          refType: 'cloud_host',
          refId: teamAccount!.id,
          description: '团队工作区创建云电脑（T-B2 最小断言）',
        }),
      });
      expect(charge.status).toBe(200);
      expect((await charge.json()) as { charged?: boolean }).toMatchObject({ charged: true });

      const teamQuoteAfter = await agentGql(CLOUD_HOST_QUOTE, undefined, login.token, teamGlobal!.id);
      expect(teamQuoteAfter.data!.cloudHostBillingQuote.availableBalance).toBe(5);

      const personalQuoteAfter = await agentGql(CLOUD_HOST_QUOTE, undefined, login.token);
      expect(personalQuoteAfter.data!.cloudHostBillingQuote.availableBalance).toBe(0);

      const personalAfter = await adminGql<{
        adminBillingAccounts: Array<{ ownerId: string; availableBalance: number }>;
      }>(BILLING_ACCOUNTS_BY_OWNER, { keyword: billingOwnerName, ownerType: 'tenant' }, token);
      expect(
        personalAfter.data!.adminBillingAccounts.find((account) => account.ownerId === login.user.id)
          ?.availableBalance,
      ).toBe(0);
    },
  );
});
