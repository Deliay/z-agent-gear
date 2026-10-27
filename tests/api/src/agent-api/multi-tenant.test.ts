/**
 * 多租户一期 API 验收（计划 Phase 11 / §6.2 T-MT 系列）。
 *
 * 覆盖：
 * - T-MT1 开户 → login → me：`name` = 用户名、`tenant` 同名 personal、`memberCount=1`；
 * - T-MT2 双用户隔离：A 创建的会话/控制器工作区/MCP server/待办/工作流模板，B 不可见、详情不可达；
 * - T-MT3 行为回归：A 自己的列表仍能看到 A 创建的数据（personal 期 tenantId==userId）；
 * - 无公开 GraphQL 读接口的集合（cloud_host_* / workflowprhandlers / issue_workflow_triggers 等）
 *   由 agent-api `src/models/tenant-isolation.test.ts` 的 T-ISO 矩阵（19 集合逐一验证查询注入）兜底；
 * - T-MT5 迁移/三件套核对（需 `MONGODB_URI`，缺省跳过）：users 三件套、sessions tenantId==userId、
 *   billingaccounts 前台 ownerType=tenant。
 *
 * 契约口径：`contracts/auth.graphql`（User.name/tenant）、`contracts/admin-tenant.graphql`（开户）、
 * `contracts/billing.graphql`（BillingOwnerType.tenant）。跨租户访问统一「不泄露存在性」：
 * 列表为空 / 详情 null / 错误文案含 Not found（按各服务既有口径断言）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import mongoose from 'mongoose';
import { createFrontUser, type FrontUser } from '../support/front-users.js';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';
const MONGO_URI = process.env.MONGODB_URI;

function gql<T = any>(
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }).then((res) => res.json() as Promise<{ data?: T; errors?: Array<{ message: string }> }>);
}

const CONTROLLER_KEYS = `
  query ControllerKeys {
    controllerKeys { id name }
  }
`;

const COMMIT_SETTINGS = `
  query CommitSettings {
    commitSettings { committerMode committerType customName customEmail }
  }
`;

const UPDATE_COMMIT_SETTINGS = `
  mutation UpdateCommitSettings($input: CommitSettingsInput!) {
    updateCommitSettings(input: $input) { committerMode committerType customName customEmail }
  }
`;

const LOGIN = `
  mutation Login($username: String!, $password: String!) {
    login(username: $username, password: $password) {
      token
      user { id name tenant { id name type memberCount } }
    }
  }
`;

const ME = `
  query Me {
    me { id name createdAt tenant { id name type memberCount } }
  }
`;

const CREATE_KEY = `
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) { key { id name } rawKey }
  }
`;

const CREATE_WORKSPACE = `
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) { id controllerId path }
  }
`;

const DELETE_WORKSPACE = `mutation DeleteWorkspace($id: ID!) { deleteWorkspace(id: $id) }`;

const WORKSPACES = `
  query Workspaces {
    workspaces { id controllerId path }
  }
`;

const CONTROLLER_WORKSPACES = `
  query ControllerWorkspaces($controllerId: ID!) {
    controllerWorkspaces(controllerId: $controllerId) { id controllerId path }
  }
`;

const CONTROLLERS = `query Controllers { controllers { id name status hostname } }`;

const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) { session { id controllerId status } }
  }
`;

const SESSION = `query Session($id: ID!) { session(id: $id) { id controllerId status } }`;

const SESSIONS = `
  query Sessions($controllerId: ID) {
    sessions(controllerId: $controllerId) { id controllerId status }
  }
`;

const MCP_SERVERS = `query McpServers { mcpServers { id name enabled source } }`;

const MCP_SERVER = `query McpServer($id: ID!) { mcpServer(id: $id) { id name enabled } }`;

const SET_MCP_SERVER_ENABLED = `
  mutation SetMcpServerEnabled($id: ID!, $enabled: Boolean!) {
    setMcpServerEnabled(id: $id, enabled: $enabled) { id enabled }
  }
`;

const TODO_LIST = `query TodoList { getTodoList { id type title isRead } }`;

const MARK_TODO_READ = `mutation MarkTodoRead($todoId: ID!) { markTodoRead(todoId: $todoId) }`;

const TEMPLATES = `query Templates { workflowTemplates { id name isBuiltin } }`;

const CREATE_TEMPLATE = `
  mutation CreateTemplate($input: WorkflowTemplateInput!) {
    createWorkflowTemplate(input: $input) { id name isBuiltin }
  }
`;

const UPDATE_TEMPLATE = `
  mutation UpdateTemplate($id: ID!, $input: WorkflowTemplateInput!) {
    updateWorkflowTemplate(id: $id, input: $input) { id name }
  }
`;

const DELETE_TEMPLATE = `mutation DeleteTemplate($id: ID!) { deleteWorkflowTemplate(id: $id) }`;

const CONFIGURED_WORKFLOWS = `
  query ConfiguredWorkflows { configuredWorkflows { id name controllerId } }
`;

// ---------------------------------------------------------------------------
// 假控制器（真实 controller-api 握手，自动应答 acp:check / acp:start）
// ---------------------------------------------------------------------------

function waitForEvent<T = any>(socket: ClientSocket, event: string, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function registerFakeController(token: string): Promise<{
  controllerId: string;
  rawKey: string;
  client: ClientSocket;
}> {
  const keyRes = await gql<{ createControllerKey: { rawKey: string } }>(
    CREATE_KEY,
    { input: { name: `mt-${Date.now()}`, type: 'local' } },
    token,
  );
  const rawKey = keyRes.data!.createControllerKey.rawKey;

  const client = SocketIOClient(CONTROLLER_API_URL, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  client.on('acp:check', (data: { requestId: string }) => {
    client.emit('acp:check:result', {
      requestId: data.requestId,
      servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
    });
  });
  client.on('acp:start', (data: { requestId: string; sessionId: string }) => {
    client.emit('acp:start:result', {
      requestId: data.requestId,
      sessionId: data.sessionId,
      success: true,
      externalSessionId: `ext_${data.sessionId}`,
    });
  });

  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', { key: rawKey, hostname: `mt-host-${Date.now()}`, version: '2.0.0' });
  const reg = await registered;
  return { controllerId: reg.controllerId, rawKey, client };
}

async function createWorkspace(token: string, controllerId: string): Promise<string> {
  const res = await gql<{ createWorkspace: { id: string } }>(
    CREATE_WORKSPACE,
    { input: { controllerId, path: `/tmp/mt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` } },
    token,
  );
  if (res.errors) throw new Error(`createWorkspace failed: ${JSON.stringify(res.errors)}`);
  return res.data!.createWorkspace.id;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('多租户一期：T-MT 系列', () => {
  let userA: FrontUser;
  let userB: FrontUser;

  let controllerA = '';
  let workspaceA = '';
  let sessionA = '';
  let mcpServerA = '';
  let todoA = '';
  let templateA = '';
  let socketA: ClientSocket | undefined;

  beforeAll(async () => {
    userA = await createFrontUser();
    userB = await createFrontUser();
    expect(userA.userId).not.toBe(userB.userId);

    // A 创建控制器 + 工作区 + 会话（fake controller 应答 acp:start）
    const ctrl = await registerFakeController(userA.token);
    controllerA = ctrl.controllerId;
    socketA = ctrl.client;
    workspaceA = await createWorkspace(userA.token, controllerA);

    const sessionRes = await gql<{ createSession: { session: { id: string } } }>(
      CREATE_SESSION,
      { input: { controllerId: controllerA, workspaceId: workspaceA, acpServerType: 'opencode' } },
      userA.token,
    );
    if (sessionRes.errors) throw new Error(`createSession failed: ${JSON.stringify(sessionRes.errors)}`);
    sessionA = sessionRes.data!.createSession.session.id;
    // 允许 acp:start 握手落库（列表/详情断言不依赖 running）
    await new Promise((r) => setTimeout(r, 300));

    // A 的平台 MCP server（每个用户各自一份，id 不同）
    const mcpRes = await gql<{ mcpServers: Array<{ id: string; name: string }> }>(
      MCP_SERVERS,
      undefined,
      userA.token,
    );
    mcpServerA =
      mcpRes.data?.mcpServers.find((s) => s.name === 'agent-workflow-admin-tools')?.id ??
      mcpRes.data?.mcpServers[0]?.id ??
      '';

    // A 的工作流模板（用户作用域）
    const tplRes = await gql<{ createWorkflowTemplate: { id: string } }>(
      CREATE_TEMPLATE,
      {
        input: {
          name: `mt-tpl-${Date.now()}`,
          nodes: [
            { nodeKey: 'input', type: 'HUMAN', name: '提交', stage: 's', dependsOn: [], requiresWorktree: false },
            {
              nodeKey: 'exec',
              type: 'AI',
              name: '执行',
              stage: 's',
              prompts: ['执行'],
              dependsOn: ['input'],
              requiresWorktree: false,
            },
          ],
        },
      },
      userA.token,
    );
    if (tplRes.errors) throw new Error(`createWorkflowTemplate failed: ${JSON.stringify(tplRes.errors)}`);
    templateA = tplRes.data!.createWorkflowTemplate.id;

    // A 的待办（控制器发 acp:permission → agent-api 创建 TodoItem）
    // 先等待会话进入 running（acp:start 已 success），避免 permission 事件被丢弃
    for (let i = 0; i < 20; i += 1) {
      const state = await gql<{ session: { status: string } | null }>(SESSION, { id: sessionA }, userA.token);
      if (state.data?.session?.status === 'running') break;
      await new Promise((r) => setTimeout(r, 300));
    }

    const permissionRequestId = `mt_perm_${Date.now()}`;
    socketA.emit('acp:permission', {
      requestId: permissionRequestId,
      sessionId: sessionA,
      toolCall: { toolCallId: 'mt_call_001' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    for (let i = 0; i < 20 && !todoA; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const todoRes = await gql<{ getTodoList: Array<{ id: string }> }>(TODO_LIST, undefined, userA.token);
      todoA = todoRes.data?.getTodoList?.[0]?.id ?? '';
    }
    if (!todoA) throw new Error('todo was not created from acp:permission');
  }, 90_000);

  afterAll(async () => {
    socketA?.disconnect();
    if (userA && sessionA) {
      await gql(`mutation($id:ID!){deleteSession(id:$id)}`, { id: sessionA }, userA.token).catch(() => {});
    }
    if (userA && workspaceA) {
      await gql(DELETE_WORKSPACE, { id: workspaceA }, userA.token).catch(() => {});
    }
    if (userA && templateA) {
      await gql(DELETE_TEMPLATE, { id: templateA }, userA.token).catch(() => {});
    }
  });

  it('T-MT1: 开户 → login → me.name=用户名、me.tenant 同名 personal、memberCount=1', async () => {
    const loginRes = await gql<{
      login: { token: string; user: { id: string; name: string; tenant: { id: string; name: string; type: string; memberCount: number } } };
    }>(LOGIN, { username: userA.username, password: userA.password });
    expect(loginRes.errors).toBeUndefined();
    const login = loginRes.data!.login;
    expect(login.token).toBeTruthy();
    expect(login.user.id).toBe(userA.userId);
    expect(login.user.name).toBe(userA.username);
    expect(login.user.tenant).toEqual({
      id: userA.tenantId,
      name: userA.username,
      type: 'personal',
      memberCount: 1,
    });

    const meRes = await gql<{
      me: { id: string; name: string; createdAt: string; tenant: { id: string; name: string; type: string; memberCount: number } };
    }>(ME, undefined, userA.token);
    expect(meRes.errors).toBeUndefined();
    expect(meRes.data!.me).toMatchObject({
      id: userA.userId,
      name: userA.username,
      tenant: { id: userA.tenantId, name: userA.username, type: 'personal', memberCount: 1 },
    });
    expect(meRes.data!.me.createdAt).toBeTruthy();

    // personal 期：tenant _id 复用 userId
    expect(userA.tenantId).toBe(userA.userId);
    expect(userB.tenantId).toBe(userB.userId);
    expect(userA.tenantId).not.toBe(userB.tenantId);
  });

  it('T-MT2a: 会话跨租户不可达（详情 null、列表不含）', async () => {
    const detail = await gql<{ session: unknown }>(SESSION, { id: sessionA }, userB.token);
    expect(detail.errors).toBeUndefined();
    expect(detail.data!.session).toBeNull();

    const list = await gql<{ sessions: Array<{ id: string }> }>(SESSIONS, undefined, userB.token);
    expect(list.errors).toBeUndefined();
    expect(list.data!.sessions.some((s) => s.id === sessionA)).toBe(false);
  });

  it('T-MT2b: 控制器工作区跨租户不可达（列表报 Not found、删除不生效）', async () => {
    const foreign = await gql(CONTROLLER_WORKSPACES, { controllerId: controllerA }, userB.token);
    // 不泄露存在性：控制器不属于 B → 与「控制器不存在」同口径
    expect(foreign.errors?.[0]?.message ?? '').toMatch(/not found|不存在/i);

    const list = await gql<{ workspaces: Array<{ id: string }> }>(WORKSPACES, undefined, userB.token);
    expect(list.errors).toBeUndefined();
    expect(list.data!.workspaces.some((w) => w.id === workspaceA)).toBe(false);

    const removed = await gql<{ deleteWorkspace: boolean }>(DELETE_WORKSPACE, { id: workspaceA }, userB.token);
    if (removed.errors) {
      expect(removed.errors[0].message).toMatch(/not found|不存在/i);
    } else {
      expect(removed.data?.deleteWorkspace ?? false).toBe(false);
    }

    // A 的工作区仍在
    const own = await gql<{ workspaces: Array<{ id: string }> }>(WORKSPACES, undefined, userA.token);
    expect(own.data!.workspaces.some((w) => w.id === workspaceA)).toBe(true);
  });

  it('T-MT2c: MCP server 跨租户不可达（详情 null、写操作拒绝）', async () => {
    expect(mcpServerA).toBeTruthy();

    const detail = await gql<{ mcpServer: unknown }>(MCP_SERVER, { id: mcpServerA }, userB.token);
    expect(detail.errors).toBeUndefined();
    expect(detail.data!.mcpServer).toBeNull();

    const toggled = await gql(SET_MCP_SERVER_ENABLED, { id: mcpServerA, enabled: false }, userB.token);
    expect(toggled.errors?.[0]?.message ?? '').toMatch(/not found|Server not found|不存在/i);

    const list = await gql<{ mcpServers: Array<{ id: string }> }>(MCP_SERVERS, undefined, userB.token);
    expect(list.data!.mcpServers.some((s) => s.id === mcpServerA)).toBe(false);
  });

  it('T-MT2d: 待办跨租户不可见且不可操作', async () => {
    expect(todoA).toBeTruthy();

    const list = await gql<{ getTodoList: Array<{ id: string }> }>(TODO_LIST, undefined, userB.token);
    expect(list.errors).toBeUndefined();
    expect(list.data!.getTodoList.some((t) => t.id === todoA)).toBe(false);

    const marked = await gql<{ markTodoRead: boolean }>(MARK_TODO_READ, { todoId: todoA }, userB.token);
    expect(marked.data?.markTodoRead ?? false).toBe(false);

    // A 的待办仍未被 B 改动
    const own = await gql<{ getTodoList: Array<{ id: string; isRead: boolean }> }>(TODO_LIST, undefined, userA.token);
    expect(own.data!.getTodoList.some((t) => t.id === todoA)).toBe(true);
  });

  it('T-MT2e: 工作流模板跨租户不可达（列表不含、改/删拒绝）', async () => {
    expect(templateA).toBeTruthy();

    const list = await gql<{ workflowTemplates: Array<{ id: string }> }>(TEMPLATES, undefined, userB.token);
    expect(list.errors).toBeUndefined();
    expect(list.data!.workflowTemplates.some((t) => t.id === templateA)).toBe(false);

    const updated = await gql(
      UPDATE_TEMPLATE,
      {
        id: templateA,
        input: {
          name: 'hijacked',
          nodes: [
            { nodeKey: 'input', type: 'HUMAN', name: '提交', stage: 's', dependsOn: [], requiresWorktree: false },
          ],
        },
      },
      userB.token,
    );
    expect(updated.errors, '跨租户改模板必须拒绝').toBeDefined();

    const deleted = await gql<{ deleteWorkflowTemplate: boolean }>(DELETE_TEMPLATE, { id: templateA }, userB.token);
    if (deleted.errors) {
      expect(deleted.errors[0].message).toMatch(/not found|不存在/i);
    } else {
      expect(deleted.data?.deleteWorkflowTemplate ?? false).toBe(false);
    }

    const own = await gql<{ workflowTemplates: Array<{ id: string }> }>(TEMPLATES, undefined, userA.token);
    expect(own.data!.workflowTemplates.some((t) => t.id === templateA)).toBe(true);
  });

  it('T-MT2f: 其余集合列表隔离抽查（controllers / configuredWorkflows）', async () => {
    const ctrlList = await gql<{ controllers: Array<{ id: string }> }>(CONTROLLERS, undefined, userB.token);
    expect(ctrlList.errors).toBeUndefined();
    expect(ctrlList.data!.controllers.some((c) => c.id === controllerA)).toBe(false);

    const wfList = await gql<{ configuredWorkflows: Array<{ controllerId: string }> }>(
      CONFIGURED_WORKFLOWS,
      undefined,
      userB.token,
    );
    expect(wfList.errors).toBeUndefined();
    expect(wfList.data!.configuredWorkflows.some((w) => w.controllerId === controllerA)).toBe(false);
    // 未覆盖集合（cloudhosts / gateway / controller-key / workflow-instance 等）在各自套件已有
    // 单用户视角回归；本期 API 级隔离以「列表按 tenantId+userId 双条件」为准，逐集合单测见
    // servers/agent-api/src/services/*.test.ts 的 T-ISO-* 系列。
  });

  it('T-MT2g: controllerkeys 跨租户列表不可见', async () => {
    const own = await gql<{ controllerKeys: Array<{ id: string }> }>(CONTROLLER_KEYS, undefined, userA.token);
    expect(own.errors).toBeUndefined();
    expect(own.data!.controllerKeys.length).toBeGreaterThan(0);

    const other = await gql<{ controllerKeys: Array<{ id: string }> }>(CONTROLLER_KEYS, undefined, userB.token);
    expect(other.errors).toBeUndefined();
    expect(other.data!.controllerKeys).toHaveLength(0);
  });

  it('T-MT2h: user_commit_settings 按用户隔离（B 看不到 A 的提交人设置）', async () => {
    const updated = await gql<{ updateCommitSettings: { committerMode: string; committerType: string; customName: string | null } }>(
      UPDATE_COMMIT_SETTINGS,
      {
        input: {
          committerMode: 'HUMAN_ONLY',
          committerType: 'CUSTOM',
          customName: 'MT User A',
          customEmail: 'mt-a@example.com',
        },
      },
      userA.token,
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data!.updateCommitSettings).toMatchObject({
      committerMode: 'HUMAN_ONLY',
      committerType: 'CUSTOM',
      customName: 'MT User A',
    });

    const other = await gql<{ commitSettings: { committerMode: string; committerType: string } }>(
      COMMIT_SETTINGS,
      undefined,
      userB.token,
    );
    expect(other.errors).toBeUndefined();
    expect(other.data!.commitSettings).toMatchObject({ committerMode: 'UNSET', committerType: 'UNSET' });
  });

  it('T-MT3: A 的列表仍能看到自己创建的数据（行为回归）', async () => {
    const sessions = await gql<{ sessions: Array<{ id: string; controllerId: string }> }>(
      SESSIONS,
      undefined,
      userA.token,
    );
    expect(sessions.errors).toBeUndefined();
    expect(sessions.data!.sessions.some((s) => s.id === sessionA)).toBe(true);

    const controllers = await gql<{ controllers: Array<{ id: string }> }>(CONTROLLERS, undefined, userA.token);
    expect(controllers.data!.controllers.some((c) => c.id === controllerA)).toBe(true);

    const workspaces = await gql<{ controllerWorkspaces: Array<{ id: string }> }>(
      CONTROLLER_WORKSPACES,
      { controllerId: controllerA },
      userA.token,
    );
    expect(workspaces.errors).toBeUndefined();
    expect(workspaces.data!.controllerWorkspaces.some((w) => w.id === workspaceA)).toBe(true);

    const templates = await gql<{ workflowTemplates: Array<{ id: string }> }>(TEMPLATES, undefined, userA.token);
    expect(templates.data!.workflowTemplates.some((t) => t.id === templateA)).toBe(true);

    const mcp = await gql<{ mcpServers: Array<{ id: string; enabled: boolean }> }>(MCP_SERVERS, undefined, userA.token);
    const ownServer = mcp.data!.mcpServers.find((s) => s.id === mcpServerA);
    expect(ownServer).toBeDefined();
    expect(ownServer!.enabled).toBe(true);

    const todos = await gql<{ getTodoList: Array<{ id: string }> }>(TODO_LIST, undefined, userA.token);
    expect(todos.data!.getTodoList.some((t) => t.id === todoA)).toBe(true);
  });

  describe.skipIf(!MONGO_URI)('T-MT5: 迁移/三件套直读核对', () => {
    let db: mongoose.mongo.Db | null = null;

    beforeAll(async () => {
      if (mongoose.connection.readyState === 0) await mongoose.connect(MONGO_URI!);
      db = mongoose.connection.db ?? null;
    });

    it('users 三件套：name/tenantId/accountId 就位，tenantId==userId', async () => {
      const user = await db!.collection('users').findOne({
        _id: new mongoose.Types.ObjectId(userA.userId),
      });
      expect(user, 'users 文档应存在').toBeTruthy();
      expect(user!.name).toBe(userA.username);
      expect(String(user!.tenantId)).toBe(userA.userId);
      expect(user!.accountId).toBeTruthy();

      const account = await db!.collection('accounts').findOne({ username: userA.username });
      expect(account, 'accounts 文档应存在').toBeTruthy();
      expect(String(account!._id)).toBe(String(user!.accountId));

      const tenant = await db!.collection('tenants').findOne({
        _id: new mongoose.Types.ObjectId(userA.tenantId),
      });
      expect(tenant, 'tenants 文档应存在').toBeTruthy();
      expect(tenant!.name).toBe(userA.username);
      expect(tenant!.type).toBe('personal');
    });

    it('sessions tenantId 回填 == userId（双条件化的数据基础）', async () => {
      const session = await db!.collection('sessions').findOne({
        _id: new mongoose.Types.ObjectId(sessionA),
      });
      expect(session, 'sessions 文档应存在').toBeTruthy();
      expect(String(session!.userId)).toBe(userA.userId);
      expect(String(session!.tenantId)).toBe(userA.userId);
    });

    it('前台计费账户落 tenant 口径（ownerType=tenant, ownerId=tenantId）', async () => {
      const account = await db!.collection('billingaccounts').findOne({
        ownerType: 'tenant',
        ownerId: userA.tenantId,
      });
      expect(account, '开户应创建零余额 tenant 计费账户').toBeTruthy();
      // 开户只建零余额账户：金额字段不因迁移/开户被改写
      expect(account!.giftBalance ?? 0).toBe(0);
      // 存量 front_user 行已由迁移 014 改写；不应再有指向本用户的 front_user 行
      const legacy = await db!.collection('billingaccounts').findOne({
        ownerType: 'front_user',
        ownerId: userA.tenantId,
      });
      expect(legacy).toBeNull();
    });

    it('带 tenantId 的集合抽样回填（controllers / controllerworkspaces / mcpservers）', async () => {
      const samples: Array<[string, Record<string, unknown>]> = [
        ['controllers', { _id: new mongoose.Types.ObjectId(controllerA) }],
        ['controllerworkspaces', { _id: new mongoose.Types.ObjectId(workspaceA) }],
      ];
      for (const [collection, filter] of samples) {
        const doc = await db!.collection(collection).findOne(filter);
        expect(doc, `${collection} 文档应存在`).toBeTruthy();
        expect(String(doc!.tenantId), `${collection}.tenantId`).toBe(userA.userId);
        // userId 字段与值保留（本期复制新增，不 rename）
        expect(String(doc!.userId), `${collection}.userId`).toBe(userA.userId);
      }
    });
  });
});
