/**
 * 多租户 MCP 服务 upsert API 回归（PR #361）。
 *
 * 背景：`mcpservers` 在租户化时只新增了 `{tenantId,userId,name}` 唯一索引，
 * 旧的 `{userId,name}` 唯一索引未删除。`mcpServers` 查询会幂等 ensure
 * 平台内置 `agent-workflow-admin-tools`；同一用户切换到团队租户后再次 ensure，
 * 过滤条件带 team tenantId 查不到个人行，插入又被旧索引拦截 → E11000。
 *
 * 本用例：个人租户先 ensure 一次 → 加入团队租户 → 团队全局工作区再 ensure 一次，
 * 断言 GraphQL 成功、两条不同 tenantId 的行并存、旧索引不再存在。
 *
 * 依赖：agent-api + admin-api 就绪、`INTERNAL_API_TOKEN`（开户）、
 * `MONGODB_URI`（落库/索引断言）、管理员口令归一化。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { adminGql, ensureAdminLogin } from '../admin-api/helpers.js';
import { createFrontUser, type FrontUser } from '../support/front-users.js';

const AGENT_GRAPHQL = process.env.API_URL || 'http://localhost:10001/graphql';
const HAS_MONGO = Boolean(process.env.MONGODB_URI);
const ENABLED = Boolean(HAS_MONGO && process.env.INTERNAL_API_TOKEN);

const ADMIN_TOOLS = 'agent-workflow-admin-tools';

const MCP_SERVERS = `
  query McpServers {
    mcpServers { id name source transport enabled }
  }
`;

const MY_WORKSPACES = `
  query MyWorkspaces {
    myWorkspaces { id name type myRole readOnly tenant { id type } }
  }
`;

const CREATE_TEAM_TENANT = `
  mutation CreateTeamTenant($name: String!) {
    adminCreateTeamTenant(name: $name) { id name type }
  }
`;

const ADD_TENANT_MEMBER = `
  mutation AddTenantMember($tenantId: ID!, $username: String!, $role: TenantRole) {
    adminAddTenantMember(tenantId: $tenantId, username: $username, role: $role) {
      id username role
    }
  }
`;

function agentGql<T>(
  query: string,
  token: string,
  workspaceId?: string,
): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (workspaceId) headers['x-workspace-id'] = workspaceId;
  return fetch(AGENT_GRAPHQL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  }).then((res) => res.json() as Promise<{ data?: T; errors?: Array<{ message: string }> }>);
}

async function mongoDb(): Promise<mongoose.mongo.Db> {
  if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI!);
  return mongoose.connection.db!;
}

describe.skipIf(!ENABLED)('MCP 内置服务跨租户 ensure（旧唯一索引回归）', () => {
  let user: FrontUser;
  let teamId = '';

  beforeAll(async () => {
    user = await createFrontUser();
  });

  afterAll(async () => {
    const db = await mongoDb();
    await db.collection('mcpservers').deleteMany({ userId: user.userId, name: ADMIN_TOOLS });
  });

  it('T-MCP-API1: 个人租户与团队租户可各自持有同名内置服务', async () => {
    // 个人租户：读路径 ensure 一次
    const personal = await agentGql<{ mcpServers: Array<{ name: string }> }>(
      MCP_SERVERS,
      user.token,
    );
    expect(personal.errors, JSON.stringify(personal.errors)).toBeUndefined();
    expect(personal.data!.mcpServers.some((server) => server.name === ADMIN_TOOLS)).toBe(true);

    // 开通团队租户并把该用户加为 admin
    const adminToken = await ensureAdminLogin();
    const teamName = `mcp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`.slice(
      0,
      60,
    );
    const created = await adminGql<{ adminCreateTeamTenant: { id: string; name: string } }>(
      CREATE_TEAM_TENANT,
      { name: teamName },
      adminToken,
    );
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    teamId = created.data!.adminCreateTeamTenant.id;

    const added = await adminGql(
      ADD_TENANT_MEMBER,
      { tenantId: teamId, username: user.username, role: 'admin' },
      adminToken,
    );
    expect(added.errors, JSON.stringify(added.errors)).toBeUndefined();

    const workspaces = await agentGql<{
      myWorkspaces: Array<{ id: string; type: string; tenant: { id: string } }>;
    }>(MY_WORKSPACES, user.token);
    expect(workspaces.errors, JSON.stringify(workspaces.errors)).toBeUndefined();
    const teamGlobal = workspaces.data!.myWorkspaces.find(
      (workspace) => workspace.tenant.id === teamId && workspace.type === 'global',
    );
    expect(teamGlobal, '团队租户应自动开通全局工作区').toBeDefined();

    // 团队全局工作区：再次 ensure 同名服务（修复前 E11000 userId_1_name_1）
    const team = await agentGql<{ mcpServers: Array<{ name: string }> }>(
      MCP_SERVERS,
      user.token,
      teamGlobal!.id,
    );
    expect(team.errors, JSON.stringify(team.errors)).toBeUndefined();
    expect(team.data!.mcpServers.some((server) => server.name === ADMIN_TOOLS)).toBe(true);

    const db = await mongoDb();
    const rows = await db
      .collection('mcpservers')
      .find({ userId: user.userId, name: ADMIN_TOOLS })
      .toArray();
    const tenants = rows.map((row) => String(row.tenantId));
    expect(new Set(tenants)).toEqual(new Set([user.tenantId, teamId]));

    // 旧的无租户维度唯一索引不得残留
    const indexes = await db.collection('mcpservers').indexes();
    const legacy = indexes.filter(
      (index) =>
        index.unique === true &&
        Object.keys(index.key).length === 2 &&
        index.key.userId === 1 &&
        index.key.name === 1,
    );
    expect(legacy, `残留 {userId,name} 唯一索引：${JSON.stringify(legacy)}`).toHaveLength(0);
  });
});
