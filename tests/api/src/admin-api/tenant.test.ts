/**
 * 后台租户与账户管理 API（Phase 11 / `contracts/admin-tenant.graphql`）。
 *
 * 覆盖 T-AT-API：
 * - 未鉴权（adminTenants / adminTenant / adminCreateFrontUser）；
 * - 检索与分页（keyword / page / pageSize）；
 * - 详情成员（tenant→users + account→username 关联）；
 * - 开户 → 新账户 login 闭环（tenant 同名 personal、memberCount=1）；
 * - 重名（幂等返回既有视图，或 409 USERNAME_TAKEN）/ 非法参数；
 * - 只读性：introspection 无 update/delete/disable 类 mutation，未知 id 返回 null。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { adminGql, ensureAdminLogin } from './helpers.js';
import { loginFrontUser, uniqueFrontUsername } from '../support/front-users.js';

const TENANTS = `
  query Tenants($keyword: String, $page: Int, $pageSize: Int) {
    adminTenants(keyword: $keyword, page: $page, pageSize: $pageSize) {
      id name type memberCount balance createdAt
    }
  }
`;

const TENANT = `
  query Tenant($id: ID!) {
    adminTenant(id: $id) {
      id name type createdAt
      users { id name username createdAt }
    }
  }
`;

const CREATE_FRONT_USER = `
  mutation CreateFrontUser($username: String!, $password: String!) {
    adminCreateFrontUser(username: $username, password: $password) {
      id name username createdAt
    }
  }
`;

const INTROSPECTION = `
  query Introspect {
    __schema {
      queryType { fields { name } }
      mutationType { fields { name } }
    }
  }
`;

describe('Admin Tenant API', () => {
  let token = '';
  const password = 'password123';
  // 唯一前缀，避免历史运行残留干扰检索/分页断言
  const prefix = uniqueFrontUsername('at');
  const usernameA = `${prefix}a`.slice(0, 20);
  const usernameB = `${prefix}b`.slice(0, 20);
  let createdA: { id: string; name: string; username: string; createdAt: string };

  beforeAll(async () => {
    token = await ensureAdminLogin();
  });

  it('T-AT-API1: 未鉴权时三个入口均返回 Not authenticated', async () => {
    for (const [query, variables] of [
      [TENANTS, { keyword: 'x' }],
      [TENANT, { id: '000000000000000000000000' }],
      [CREATE_FRONT_USER, { username: 'noauthuser', password }],
    ] as const) {
      const res = await adminGql(query, variables as Record<string, unknown>);
      expect(res.errors?.[0]?.message).toBe('Not authenticated');
    }
  });

  it('T-AT-API2: introspection 为只读盘点（无租户 update/delete/disable mutation）', async () => {
    const res = await adminGql<{
      __schema: {
        queryType: { fields: Array<{ name: string }> };
        mutationType: { fields: Array<{ name: string }> };
      };
    }>(INTROSPECTION);
    expect(res.errors).toBeUndefined();
    const schema = res.data!.__schema;
    const queries = schema.queryType.fields.map((f) => f.name);
    const mutations = schema.mutationType.fields.map((f) => f.name);

    expect(queries).toContain('adminTenants');
    expect(queries).toContain('adminTenant');
    expect(mutations).toContain('adminCreateFrontUser');

    // 后台不做多租户设计：契约层即不存在改/删/停用入口；租户相关写操作仅开户
    const tenantMutations = mutations.filter((name) => /tenant|frontuser/i.test(name));
    expect(tenantMutations.length).toBeGreaterThan(0);
    expect(tenantMutations.every((name) => /^adminCreateFrontUser$/i.test(name))).toBe(true);
    expect(mutations.some((n) => /^(admin)?(update|delete|remove|disable|enable)(Tenant|FrontUser)$/i.test(n))).toBe(false);
  });

  it('T-AT-API3: 开户成功 → adminTenants 检索可见 → 新账户 login 闭环', async () => {
    const created = await adminGql<{
      adminCreateFrontUser: { id: string; name: string; username: string; createdAt: string };
    }>(CREATE_FRONT_USER, { username: usernameA, password }, token);
    expect(created.errors).toBeUndefined();
    createdA = created.data!.adminCreateFrontUser;
    expect(createdA.username).toBe(usernameA);
    expect(createdA.name).toBe(usernameA);
    expect(createdA.createdAt).toBeTruthy();

    // 检索：租户名 == 登录名
    const list = await adminGql<{
      adminTenants: Array<{ id: string; name: string; type: string; memberCount: number; balance: number | null }>;
    }>(TENANTS, { keyword: usernameA }, token);
    expect(list.errors).toBeUndefined();
    const tenant = list.data!.adminTenants.find((t) => t.name === usernameA);
    expect(tenant, 'adminTenants(keyword) 应命中新租户').toBeDefined();
    expect(tenant!.type).toBe('personal');
    expect(tenant!.memberCount).toBe(1);
    // 开户同时 get-or-create 零余额租户计费账户
    expect(tenant!.balance === 0 || tenant!.balance === null).toBe(true);

    // login 闭环：新账户可直接登录前台，tenant 同名 personal
    const login = await loginFrontUser(usernameA, password);
    expect(login.user.name).toBe(usernameA);
    expect(login.user.id).toBe(createdA.id);
    expect(login.user.tenant).toMatchObject({
      id: tenant!.id,
      name: usernameA,
      type: 'personal',
      memberCount: 1,
    });
  });

  it('T-AT-API4: adminTenant 详情成员（username 取自其 account）', async () => {
    const list = await adminGql<{ adminTenants: Array<{ id: string; name: string }> }>(
      TENANTS,
      { keyword: usernameA },
      token,
    );
    const tenantId = list.data!.adminTenants.find((t) => t.name === usernameA)!.id;

    const detail = await adminGql<{
      adminTenant: {
        id: string;
        name: string;
        type: string;
        users: Array<{ id: string; name: string; username: string }>;
      } | null;
    }>(TENANT, { id: tenantId }, token);
    expect(detail.errors).toBeUndefined();
    const tenant = detail.data!.adminTenant!;
    expect(tenant.id).toBe(tenantId);
    expect(tenant.name).toBe(usernameA);
    expect(tenant.users).toHaveLength(1);
    expect(tenant.users[0]).toMatchObject({
      id: createdA.id,
      name: usernameA,
      username: usernameA,
    });
  });

  it('T-AT-API5: 检索与分页（keyword 过滤 + pageSize 生效）', async () => {
    const second = await adminGql<{ adminCreateFrontUser: { id: string } }>(
      CREATE_FRONT_USER,
      { username: usernameB, password },
      token,
    );
    expect(second.errors).toBeUndefined();

    const all = await adminGql<{ adminTenants: Array<{ id: string; name: string }> }>(
      TENANTS,
      { keyword: prefix },
      token,
    );
    expect(all.errors).toBeUndefined();
    const names = all.data!.adminTenants.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([usernameA, usernameB]));

    const firstPage = await adminGql<{ adminTenants: Array<{ id: string }> }>(
      TENANTS,
      { keyword: prefix, page: 1, pageSize: 1 },
      token,
    );
    expect(firstPage.errors).toBeUndefined();
    expect(firstPage.data!.adminTenants).toHaveLength(1);

    const secondPage = await adminGql<{ adminTenants: Array<{ id: string }> }>(
      TENANTS,
      { keyword: prefix, page: 2, pageSize: 1 },
      token,
    );
    expect(secondPage.errors).toBeUndefined();
    expect(secondPage.data!.adminTenants).toHaveLength(1);
    expect(secondPage.data!.adminTenants[0].id).not.toBe(firstPage.data!.adminTenants[0].id);
  });

  it('T-AT-API6: 重名开户不产生第二个用户（幂等视图或 409 USERNAME_TAKEN）', async () => {
    const again = await adminGql<{ adminCreateFrontUser: { id: string; username: string } }>(
      CREATE_FRONT_USER,
      { username: usernameA, password },
      token,
    );
    if (again.errors) {
      // 冲突映射：契约错误体 USERNAME_TAKEN
      expect(again.errors[0].message).toMatch(/USERNAME_TAKEN|already taken/i);
    } else {
      // 幂等：返回既有三件套视图（计划 §3.2 裁决 6）
      expect(again.data!.adminCreateFrontUser.id).toBe(createdA.id);
      expect(again.data!.adminCreateFrontUser.username).toBe(usernameA);
    }

    const list = await adminGql<{ adminTenants: Array<{ id: string; name: string }> }>(
      TENANTS,
      { keyword: usernameA },
      token,
    );
    expect(list.data!.adminTenants.filter((t) => t.name === usernameA)).toHaveLength(1);
  });

  it('T-AT-API7: 非法用户名/密码与未知租户详情', async () => {
    const shortUsername = await adminGql(CREATE_FRONT_USER, { username: 'a', password }, token);
    expect(shortUsername.errors?.[0]?.message).toBe('Username must be between 2 and 20 characters');

    const longUsername = await adminGql(
      CREATE_FRONT_USER,
      { username: 'x'.repeat(21), password },
      token,
    );
    expect(longUsername.errors?.[0]?.message).toBe('Username must be between 2 and 20 characters');

    const shortPassword = await adminGql(
      CREATE_FRONT_USER,
      { username: uniqueFrontUsername('short'), password: '12345' },
      token,
    );
    expect(shortPassword.errors?.[0]?.message).toBe('Password must be at least 6 characters');

    const missing = await adminGql<{ adminTenant: unknown }>(
      TENANT,
      { id: '000000000000000000000000' },
      token,
    );
    expect(missing.errors).toBeUndefined();
    expect(missing.data!.adminTenant).toBeNull();

    const invalid = await adminGql<{ adminTenant: unknown }>(TENANT, { id: 'not-an-id' }, token);
    expect(invalid.errors).toBeUndefined();
    expect(invalid.data!.adminTenant).toBeNull();
  });
});
