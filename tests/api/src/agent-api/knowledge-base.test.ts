import { describe, it, expect, beforeAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import { adminGql, ensureAdminLogin } from '../admin-api/helpers.js';
import { loginFrontUser, uniqueFrontUsername } from '../support/front-users.js';

/**
 * 知识库 API 集成测试（需求 #495 / 计划 §6.2 T-KB-API1~6）。
 *
 * 前置：`aspire start && aspire wait agent-api admin-api controller-api`，
 * `INTERNAL_API_TOKEN`（开户中转）、`ADMIN_INITIAL_PASSWORD`（admin-api 管理员口令归一化），
 * 以及 controller-api 可达（MCP 用例经 fake controller relay）。
 *
 * 矩阵：
 * - T-KB-API1 未认证 12 入口一律 `Not authenticated`；
 * - T-KB-API2 库 CRUD 全链路 + 重名 + 默认模式（global READ_ONLY / normal NONE）+ myAccess；
 * - T-KB-API3 文档 CRUD + 事件（删除释放路径、同路径重建历史延续、limit/before）；
 * - T-KB-API4 team 租户 admin/developer/outsider × 四档模式 × 本工作区/全局库；
 * - T-KB-API5 平台 MCP `agent-knowledge-base-tools` 经 fake controller relay（tools/list 门控、
 *   六工具、越权 isError、name 解析与多命中）；
 * - T-KB-API6 路径与输入校验矩阵（14 条白名单文案逐字覆盖）。
 */

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';

type GqlResult<T = any> = { data?: T; errors?: Array<{ message: string }> };

async function gql<T = any>(
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
  workspaceId?: string,
): Promise<GqlResult<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (workspaceId) headers['x-workspace-id'] = workspaceId;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as GqlResult<T>;
}

function expectNoErrors<T>(result: GqlResult<T>): T {
  expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();
  return result.data as T;
}

function expectError<T>(result: GqlResult<T>, message: string): void {
  expect(result.errors?.[0]?.message, JSON.stringify(result)).toBe(message);
}

// ---------------------------------------------------------------------------
// GraphQL 文档
// ---------------------------------------------------------------------------

const ADMIN_CREATE_FRONT_USER = `
  mutation CreateFrontUser($username: String!, $password: String!) {
    adminCreateFrontUser(username: $username, password: $password) { id name username }
  }
`;

const ADMIN_CREATE_TEAM = `
  mutation CreateTeamTenant($name: String!) {
    adminCreateTeamTenant(name: $name) { id name type memberCount }
  }
`;

const ADMIN_ADD_MEMBER = `
  mutation AddTenantMember($tenantId: ID!, $username: String!, $role: TenantRole) {
    adminAddTenantMember(tenantId: $tenantId, username: $username, role: $role) {
      id name username role
    }
  }
`;

const MY_WORKSPACES = `
  query MyWorkspaces {
    myWorkspaces { id name type tenant { id name type } }
  }
`;

const CREATE_TENANT_WORKSPACE = `
  mutation CreateTenantWorkspace($name: String!) {
    createTenantWorkspace(name: $name) { id name type }
  }
`;

const ADD_WORKSPACE_MEMBER = `
  mutation AddWorkspaceMember($workspaceId: ID!, $userId: ID!) {
    addTenantWorkspaceMember(workspaceId: $workspaceId, userId: $userId) { id name }
  }
`;

const KB_FIELDS = `
  id name permissionMode global
  myAccess { canRead canCreate canUpdate canDelete canManage }
  createdAt updatedAt
`;

const KB_LIST = `query { knowledgeBases { ${KB_FIELDS} } }`;
const KB_TREE = `query {
  knowledgeBaseTree {
    knowledgeBase { ${KB_FIELDS} }
    documents { path title tags description updatedAt }
  }
}`;
const KB_DOCS = `
  query Docs($knowledgeBaseId: ID!, $prefix: String) {
    knowledgeBaseDocuments(knowledgeBaseId: $knowledgeBaseId, prefix: $prefix) {
      path title tags description updatedAt
    }
  }
`;
const KB_DOC = `
  query Doc($knowledgeBaseId: ID!, $path: String!) {
    knowledgeBaseDocument(knowledgeBaseId: $knowledgeBaseId, path: $path) {
      path title tags description content createdByName updatedByName createdAt updatedAt
    }
  }
`;
const KB_EVENTS = `
  query Events($knowledgeBaseId: ID!, $path: String, $limit: Int, $before: String) {
    knowledgeBaseEvents(knowledgeBaseId: $knowledgeBaseId, path: $path, limit: $limit, before: $before) {
      id path op fromPath title tags description content actorName createdAt
    }
  }
`;

const CREATE_KB = `mutation CreateKb($name: String!) {
  createKnowledgeBase(name: $name) { ${KB_FIELDS} }
}`;
const RENAME_KB = `mutation RenameKb($id: ID!, $name: String!) {
  renameKnowledgeBase(id: $id, name: $name) { ${KB_FIELDS} }
}`;
const UPDATE_KB_PERMISSION = `mutation UpdatePermission($id: ID!, $permissionMode: KnowledgeBasePermissionMode!) {
  updateKnowledgeBasePermission(id: $id, permissionMode: $permissionMode) { ${KB_FIELDS} }
}`;
const DELETE_KB = `mutation DeleteKb($id: ID!) { deleteKnowledgeBase(id: $id) }`;
const CREATE_DOC = `mutation CreateDoc($knowledgeBaseId: ID!, $path: String!, $input: KnowledgeBaseDocumentInput!) {
  createKnowledgeBaseDocument(knowledgeBaseId: $knowledgeBaseId, path: $path, input: $input) {
    path title tags description content createdByName updatedByName createdAt updatedAt
  }
}`;
const UPDATE_DOC = `mutation UpdateDoc($knowledgeBaseId: ID!, $path: String!, $input: KnowledgeBaseDocumentInput!) {
  updateKnowledgeBaseDocument(knowledgeBaseId: $knowledgeBaseId, path: $path, input: $input) {
    path title tags description content createdByName updatedByName createdAt updatedAt
  }
}`;
const MOVE_DOC = `mutation MoveDoc($knowledgeBaseId: ID!, $path: String!, $input: KnowledgeBaseDocumentInput!, $newPath: String) {
  updateKnowledgeBaseDocument(knowledgeBaseId: $knowledgeBaseId, path: $path, input: $input, newPath: $newPath) {
    path title tags description content createdByName updatedByName createdAt updatedAt
  }
}`;
const DELETE_DOC = `mutation DeleteDoc($knowledgeBaseId: ID!, $path: String!) {
  deleteKnowledgeBaseDocument(knowledgeBaseId: $knowledgeBaseId, path: $path)
}`;

const CREATE_CONTROLLER_KEY = `
  mutation CreateKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) { key { id name } rawKey }
  }
`;
const CREATE_CONTROLLER_WORKSPACE = `
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) { id controllerId path }
  }
`;
const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) { session { id controllerId acpServerType } }
  }
`;
const CLOSE_SESSION = `mutation CloseSession($id: ID!) { closeSession(id: $id) }`;

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

interface FrontIdentity {
  id: string;
  username: string;
  password: string;
  token: string;
}

const PASSWORD = 'testpass123';
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let adminToken = '';
let teamId = '';
let owner: FrontIdentity;
let developer: FrontIdentity;
let outsider: FrontIdentity;
let globalWorkspaceId = '';
let normalWorkspaceId = '';
let outsiderWorkspaceId = '';

async function createFrontIdentity(prefix: string): Promise<FrontIdentity> {
  const username = uniqueFrontUsername(prefix);
  const created = await adminGql<{ adminCreateFrontUser: { id: string; name: string; username: string } }>(
    ADMIN_CREATE_FRONT_USER,
    { username, password: PASSWORD },
    adminToken,
  );
  expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
  const login = await loginFrontUser(username, PASSWORD);
  return { id: created.data!.adminCreateFrontUser.id, username, password: PASSWORD, token: login.token };
}

async function myWorkspaces(token: string) {
  const body = expectNoErrors(
    await gql<{ myWorkspaces: Array<{ id: string; name: string; type: string; tenant: { id: string; type: string } }> }>(
      MY_WORKSPACES,
      undefined,
      token,
    ),
  );
  return body.myWorkspaces;
}

async function createKnowledgeBase(
  token: string,
  workspaceId: string | undefined,
  name: string,
): Promise<any> {
  return expectNoErrors(
    await gql<{ createKnowledgeBase: any }>(CREATE_KB, { name }, token, workspaceId),
  ).createKnowledgeBase;
}

async function setPermission(
  token: string,
  workspaceId: string | undefined,
  id: string,
  permissionMode: string,
): Promise<any> {
  return expectNoErrors(
    await gql<{ updateKnowledgeBasePermission: any }>(
      UPDATE_KB_PERMISSION,
      { id, permissionMode },
      token,
      workspaceId,
    ),
  ).updateKnowledgeBasePermission;
}

async function createDocument(
  token: string,
  workspaceId: string | undefined,
  knowledgeBaseId: string,
  path: string,
  input: Record<string, unknown>,
): Promise<any> {
  return expectNoErrors(
    await gql<{ createKnowledgeBaseDocument: any }>(
      CREATE_DOC,
      { knowledgeBaseId, path, input },
      token,
      workspaceId,
    ),
  ).createKnowledgeBaseDocument;
}

function docInput(overrides: Record<string, unknown> = {}) {
  return {
    title: `文档-${suffix}`,
    tags: ['tag-a'],
    description: '描述',
    content: '# 内容',
    ...overrides,
  };
}

beforeAll(async () => {
  adminToken = await ensureAdminLogin();
  owner = await createFrontIdentity('kbo');
  developer = await createFrontIdentity('kbd');
  outsider = await createFrontIdentity('kbx');

  const team = expectNoErrors(
    await adminGql<any>(ADMIN_CREATE_TEAM, { name: `kbt-${suffix}`.slice(0, 60) }, adminToken),
  ).adminCreateTeamTenant;
  teamId = team.id;

  for (const [identity, role] of [
    [owner, 'admin'],
    [developer, 'developer'],
  ] as const) {
    const added = await adminGql<any>(
      ADMIN_ADD_MEMBER,
      { tenantId: teamId, username: identity.username, role },
      adminToken,
    );
    expect(added.errors, JSON.stringify(added.errors)).toBeUndefined();
  }

  const workspaces = await myWorkspaces(owner.token);
  const global = workspaces.find((item) => item.tenant.id === teamId && item.type === 'global');
  expect(global, 'team 租户应有全局工作区').toBeTruthy();
  globalWorkspaceId = global!.id;

  const normal = expectNoErrors(
    await gql<{ createTenantWorkspace: any }>(
      CREATE_TENANT_WORKSPACE,
      { name: `kb-ws-${suffix}` },
      owner.token,
      globalWorkspaceId,
    ),
  ).createTenantWorkspace;
  normalWorkspaceId = normal.id;
  expectNoErrors(
    await gql(
      ADD_WORKSPACE_MEMBER,
      { workspaceId: normalWorkspaceId, userId: developer.id },
      owner.token,
      globalWorkspaceId,
    ),
  );

  const outsiderSpaces = await myWorkspaces(outsider.token);
  outsiderWorkspaceId =
    outsiderSpaces.find((item) => item.type === 'global')?.id ?? outsiderSpaces[0]?.id ?? '';
  expect(outsiderWorkspaceId).toBeTruthy();
}, 120_000);

// ---------------------------------------------------------------------------
// T-KB-API1 未认证
// ---------------------------------------------------------------------------

describe('知识库 API（T-KB-API-*）', () => {
  it('T-KB-API1: 未认证 Query×5 / Mutation×7 全入口 Not authenticated', async () => {
    const placeholder = '507f1f77bcf86cd799439011';
    const cases: Array<[string, Record<string, unknown>]> = [
      [KB_LIST, {}],
      [KB_TREE, {}],
      [KB_DOCS, { knowledgeBaseId: placeholder }],
      [KB_DOC, { knowledgeBaseId: placeholder, path: '/a' }],
      [KB_EVENTS, { knowledgeBaseId: placeholder }],
      [CREATE_KB, { name: 'x' }],
      [RENAME_KB, { id: placeholder, name: 'x' }],
      [UPDATE_KB_PERMISSION, { id: placeholder, permissionMode: 'READ_ONLY' }],
      [DELETE_KB, { id: placeholder }],
      [CREATE_DOC, { knowledgeBaseId: placeholder, path: '/a', input: docInput() }],
      [UPDATE_DOC, { knowledgeBaseId: placeholder, path: '/a', input: docInput() }],
      [DELETE_DOC, { knowledgeBaseId: placeholder, path: '/a' }],
    ];
    for (const [query, variables] of cases) {
      const result = await gql(query, variables);
      expectError(result, 'Not authenticated');
    }
  });

  // -------------------------------------------------------------------------
  // T-KB-API2 库 CRUD
  // -------------------------------------------------------------------------

  it('T-KB-API2: 库 CRUD + 重名 + 默认模式 + myAccess', async () => {
    const normalName = `KB-普通-${suffix}`;
    const created = await createKnowledgeBase(owner.token, normalWorkspaceId, `  ${normalName}  `);
    expect(created.name).toBe(normalName);
    expect(created.permissionMode).toBe('NONE');
    expect(created.global).toBe(false);
    expect(created.myAccess).toEqual({
      canRead: true,
      canCreate: true,
      canUpdate: true,
      canDelete: true,
      canManage: true,
    });

    const globalName = `KB-全局-${suffix}`;
    const globalCreated = await createKnowledgeBase(owner.token, globalWorkspaceId, globalName);
    expect(globalCreated.permissionMode).toBe('READ_ONLY');
    expect(globalCreated.global).toBe(true);

    // 重名逐字
    expectError(
      await gql(CREATE_KB, { name: normalName }, owner.token, normalWorkspaceId),
      'knowledge base name already exists',
    );
    // 非法名称
    expectError(
      await gql(CREATE_KB, { name: '   ' }, owner.token, normalWorkspaceId),
      'invalid knowledge base name',
    );

    // 列表 + 树
    const list = expectNoErrors(
      await gql<{ knowledgeBases: any[] }>(KB_LIST, undefined, owner.token, normalWorkspaceId),
    ).knowledgeBases;
    const mine = list.find((item) => item.id === created.id);
    expect(mine).toMatchObject({ name: normalName, global: false, permissionMode: 'NONE' });

    await createDocument(
      owner.token,
      normalWorkspaceId,
      created.id,
      `/${docInput().title}`,
      docInput(),
    );
    const tree = expectNoErrors(
      await gql<{ knowledgeBaseTree: any[] }>(KB_TREE, undefined, owner.token, normalWorkspaceId),
    ).knowledgeBaseTree;
    const node = tree.find((item) => item.knowledgeBase.id === created.id);
    expect(node.documents).toHaveLength(1);
    expect(node.documents[0].title).toBe(`文档-${suffix}`);

    // 改名 / 改权限
    const renamed = expectNoErrors(
      await gql<{ renameKnowledgeBase: any }>(
        RENAME_KB,
        { id: created.id, name: `${normalName}-改` },
        owner.token,
        normalWorkspaceId,
      ),
    ).renameKnowledgeBase;
    expect(renamed.name).toBe(`${normalName}-改`);

    const full = await setPermission(owner.token, normalWorkspaceId, created.id, 'FULL_ACCESS');
    expect(full.permissionMode).toBe('FULL_ACCESS');

    // 删除（级联）
    expect(
      expectNoErrors(
        await gql<{ deleteKnowledgeBase: boolean }>(
          DELETE_KB,
          { id: created.id },
          owner.token,
          normalWorkspaceId,
        ),
      ).deleteKnowledgeBase,
    ).toBe(true);
    const afterDelete = expectNoErrors(
      await gql<{ knowledgeBases: any[] }>(KB_LIST, undefined, owner.token, normalWorkspaceId),
    ).knowledgeBases;
    expect(afterDelete.map((item) => item.id)).not.toContain(created.id);
  });

  // -------------------------------------------------------------------------
  // T-KB-API3 文档 CRUD + 事件
  // -------------------------------------------------------------------------

  it('T-KB-API3: 文档 CRUD + 事件（删除释放路径、同路径重建历史延续、limit/before）', async () => {
    const kb = await createKnowledgeBase(owner.token, normalWorkspaceId, `KB-事件-${suffix}`);
    await setPermission(owner.token, normalWorkspaceId, kb.id, 'FULL_ACCESS');

    // createKnowledgeBaseDocument 显式接收 path（服务端归一化）
    const created = await createDocument(
      owner.token,
      normalWorkspaceId,
      kb.id,
      `/guide/新文档-${suffix}`,
      {
        ...docInput({ title: `新文档-${suffix}`, tags: [' a ', 'a', 'b'] }),
      },
    );
    expect(created.path).toBe(`/guide/新文档-${suffix}`);
    expect(created.title).toBe(`新文档-${suffix}`);
    expect(created.tags).toEqual(['a', 'b']);
    expect(created.createdByName).toBe(owner.username);

    const updated = expectNoErrors(
      await gql<{ updateKnowledgeBaseDocument: any }>(
        UPDATE_DOC,
        {
          knowledgeBaseId: kb.id,
          path: created.path,
          input: { ...docInput(), title: 'v2', content: 'c2' },
        },
        owner.token,
        normalWorkspaceId,
      ),
    ).updateKnowledgeBaseDocument;
    expect(updated.title).toBe('v2');

    // 列表不含 content
    const docs = expectNoErrors(
      await gql<{ knowledgeBaseDocuments: any[] }>(
        KB_DOCS,
        { knowledgeBaseId: kb.id },
        owner.token,
        normalWorkspaceId,
      ),
    ).knowledgeBaseDocuments;
    expect(docs).toEqual([
      {
        path: created.path,
        title: 'v2',
        tags: ['tag-a'],
        description: '描述',
        updatedAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(docs)).not.toContain('c2');

    // 单文档完整内容
    const doc = expectNoErrors(
      await gql<{ knowledgeBaseDocument: any }>(
        KB_DOC,
        { knowledgeBaseId: kb.id, path: created.path },
        owner.token,
        normalWorkspaceId,
      ),
    ).knowledgeBaseDocument;
    expect(doc).toMatchObject({ path: created.path, title: 'v2', content: 'c2' });
    expect(doc.updatedByName).toBe(owner.username);

    // 删除 → 路径释放 → 同路径重建（历史延续）
    expect(
      expectNoErrors(
        await gql<{ deleteKnowledgeBaseDocument: boolean }>(
          DELETE_DOC,
          { knowledgeBaseId: kb.id, path: created.path },
          owner.token,
          normalWorkspaceId,
        ),
      ).deleteKnowledgeBaseDocument,
    ).toBe(true);
    const afterDelete = expectNoErrors(
      await gql<{ knowledgeBaseDocument: any }>(
        KB_DOC,
        { knowledgeBaseId: kb.id, path: created.path },
        owner.token,
        normalWorkspaceId,
      ),
    ).knowledgeBaseDocument;
    expect(afterDelete).toBeNull();

    await createDocument(owner.token, normalWorkspaceId, kb.id, created.path, {
      ...docInput({ content: 'c3' }),
    });

    const events = expectNoErrors(
      await gql<{ knowledgeBaseEvents: any[] }>(
        KB_EVENTS,
        { knowledgeBaseId: kb.id, path: created.path },
        owner.token,
        normalWorkspaceId,
      ),
    ).knowledgeBaseEvents;
    expect(events.map((event) => event.op)).toEqual(['CREATE', 'DELETE', 'UPDATE', 'CREATE']);
    expect(events[0].content).toBe('c3');
    expect(events[2].content).toBe('c2');
    expect(events[1].content).toBe('c2'); // DELETE 保留删除前最后内容
    expect(events.every((event) => event.actorName === owner.username)).toBe(true);

    // 分页：limit 截断 + before 游标（createdAt 倒序）
    const limited = expectNoErrors(
      await gql<{ knowledgeBaseEvents: any[] }>(
        KB_EVENTS,
        { knowledgeBaseId: kb.id, limit: 2 },
        owner.token,
        normalWorkspaceId,
      ),
    ).knowledgeBaseEvents;
    expect(limited).toHaveLength(2);
    expect(limited[0].createdAt >= limited[1].createdAt).toBe(true);
    const before = expectNoErrors(
      await gql<{ knowledgeBaseEvents: any[] }>(
        KB_EVENTS,
        { knowledgeBaseId: kb.id, limit: 1, before: limited[0].createdAt },
        owner.token,
        normalWorkspaceId,
      ),
    ).knowledgeBaseEvents;
    expect(before).toHaveLength(1);
    expect(before[0].createdAt < limited[0].createdAt).toBe(true);

    // 移动（#541）：历史随文档带入新路径 + MOVE 事件；原路径释放可重建且历史独立
    const moveKb = await createKnowledgeBase(owner.token, normalWorkspaceId, `KB-移动-${suffix}`);
    await setPermission(owner.token, normalWorkspaceId, moveKb.id, 'FULL_ACCESS');
    await createDocument(owner.token, normalWorkspaceId, moveKb.id, '/from', docInput({ title: 'origin' }));

    const moved = expectNoErrors(
      await gql<{ updateKnowledgeBaseDocument: any }>(
        MOVE_DOC,
        {
          knowledgeBaseId: moveKb.id,
          path: '/from',
          input: docInput({ title: 'origin' }),
          newPath: '/to/nested',
        },
        owner.token,
        normalWorkspaceId,
      ),
    ).updateKnowledgeBaseDocument;
    expect(moved.path).toBe('/to/nested');

    const movedDoc = expectNoErrors(
      await gql<{ knowledgeBaseDocument: any }>(
        KB_DOC,
        { knowledgeBaseId: moveKb.id, path: '/to/nested' },
        owner.token,
        normalWorkspaceId,
      ),
    ).knowledgeBaseDocument;
    expect(movedDoc).toMatchObject({ path: '/to/nested', title: 'origin' });

    const movedEvents = expectNoErrors(
      await gql<{ knowledgeBaseEvents: any[] }>(
        KB_EVENTS,
        { knowledgeBaseId: moveKb.id, path: '/to/nested' },
        owner.token,
        normalWorkspaceId,
      ),
    ).knowledgeBaseEvents;
    expect(movedEvents.map((event) => event.op)).toEqual(['MOVE', 'CREATE']);
    expect(movedEvents[0]).toMatchObject({
      path: '/to/nested',
      fromPath: '/from',
      actorName: owner.username,
      title: 'origin',
    });
    expect(movedEvents[1].fromPath).toBeNull();

    // 原路径释放：可立即重建，历史仅含自身 CREATE
    const oldDoc = expectNoErrors(
      await gql<{ knowledgeBaseDocument: any }>(
        KB_DOC,
        { knowledgeBaseId: moveKb.id, path: '/from' },
        owner.token,
        normalWorkspaceId,
      ),
    ).knowledgeBaseDocument;
    expect(oldDoc).toBeNull();
    await createDocument(owner.token, normalWorkspaceId, moveKb.id, '/from', docInput({ title: 'reborn' }));
    const rebornEvents = expectNoErrors(
      await gql<{ knowledgeBaseEvents: any[] }>(
        KB_EVENTS,
        { knowledgeBaseId: moveKb.id, path: '/from' },
        owner.token,
        normalWorkspaceId,
      ),
    ).knowledgeBaseEvents;
    expect(rebornEvents.map((event) => event.op)).toEqual(['CREATE']);

    // 目标占用 / 非法路径逐字
    expectError(
      await gql(
        MOVE_DOC,
        { knowledgeBaseId: moveKb.id, path: '/from', input: docInput(), newPath: '/to/nested' },
        owner.token,
        normalWorkspaceId,
      ),
      'knowledge base document already exists',
    );
    expectError(
      await gql(
        MOVE_DOC,
        { knowledgeBaseId: moveKb.id, path: '/from', input: docInput(), newPath: 'no-slash' },
        owner.token,
        normalWorkspaceId,
      ),
      'invalid document path',
    );
  });

  // -------------------------------------------------------------------------
  // T-KB-API4 权限矩阵
  // -------------------------------------------------------------------------

  it('T-KB-API4: admin/developer/outsider × 四模式 × 本工作区/全局库；收紧即时生效、不泄露存在性', async () => {
    const kb = await createKnowledgeBase(owner.token, normalWorkspaceId, `KB-矩阵-${suffix}`);
    await createDocument(owner.token, normalWorkspaceId, kb.id, '/m', docInput({ content: 'secret' }));

    // NONE：developer 不可见（列表不出现、文档 null、写 → not found）
    const devListNone = expectNoErrors(
      await gql<{ knowledgeBases: any[] }>(KB_LIST, undefined, developer.token, normalWorkspaceId),
    ).knowledgeBases;
    expect(devListNone.map((item) => item.id)).not.toContain(kb.id);

    const devDocNone = expectNoErrors(
      await gql<{ knowledgeBaseDocument: any }>(
        KB_DOC,
        { knowledgeBaseId: kb.id, path: '/m' },
        developer.token,
        normalWorkspaceId,
      ),
    ).knowledgeBaseDocument;
    expect(devDocNone).toBeNull();
    expectError(
      await gql(UPDATE_DOC, { knowledgeBaseId: kb.id, path: '/m', input: docInput() }, developer.token, normalWorkspaceId),
      'knowledge base not found',
    );

    // READ_ONLY：可见可读、不可写
    await setPermission(owner.token, normalWorkspaceId, kb.id, 'READ_ONLY');
    const devListRead = expectNoErrors(
      await gql<{ knowledgeBases: any[] }>(KB_LIST, undefined, developer.token, normalWorkspaceId),
    ).knowledgeBases;
    const devView = devListRead.find((item) => item.id === kb.id);
    expect(devView.myAccess).toEqual({
      canRead: true,
      canCreate: false,
      canUpdate: false,
      canDelete: false,
      canManage: false,
    });
    expectError(
      await gql(UPDATE_DOC, { knowledgeBaseId: kb.id, path: '/m', input: docInput() }, developer.token, normalWorkspaceId),
      'knowledge base permission denied',
    );

    // UPDATE_ONLY：可建/可改、不可删
    await setPermission(owner.token, normalWorkspaceId, kb.id, 'UPDATE_ONLY');
    expectNoErrors(
      await gql(
        UPDATE_DOC,
        { knowledgeBaseId: kb.id, path: '/m', input: docInput({ content: 'v2' }) },
        developer.token,
        normalWorkspaceId,
      ),
    );
    await createDocument(developer.token, normalWorkspaceId, kb.id, '/n', docInput());
    expectError(
      await gql(DELETE_DOC, { knowledgeBaseId: kb.id, path: '/m' }, developer.token, normalWorkspaceId),
      'knowledge base permission denied',
    );

    // FULL_ACCESS：可删
    await setPermission(owner.token, normalWorkspaceId, kb.id, 'FULL_ACCESS');
    expect(
      expectNoErrors(
        await gql<{ deleteKnowledgeBaseDocument: boolean }>(
          DELETE_DOC,
          { knowledgeBaseId: kb.id, path: '/m' },
          developer.token,
          normalWorkspaceId,
        ),
      ).deleteKnowledgeBaseDocument,
    ).toBe(true);

    // 移动权限 = canUpdate（#541）：READ_ONLY 拒绝、UPDATE_ONLY 放行
    await setPermission(owner.token, normalWorkspaceId, kb.id, 'READ_ONLY');
    expectError(
      await gql(
        MOVE_DOC,
        { knowledgeBaseId: kb.id, path: '/n', input: docInput(), newPath: '/n-moved' },
        developer.token,
        normalWorkspaceId,
      ),
      'knowledge base permission denied',
    );
    await setPermission(owner.token, normalWorkspaceId, kb.id, 'UPDATE_ONLY');
    const devMoved = expectNoErrors(
      await gql<{ updateKnowledgeBaseDocument: any }>(
        MOVE_DOC,
        { knowledgeBaseId: kb.id, path: '/n', input: docInput(), newPath: '/n-moved' },
        developer.token,
        normalWorkspaceId,
      ),
    ).updateKnowledgeBaseDocument;
    expect(devMoved.path).toBe('/n-moved');

    // 全局工作区库：普通工作区 developer 可见；READ_ONLY 只读，UPDATE_ONLY 可写（D2 有意偏离）
    const globalKb = await createKnowledgeBase(owner.token, globalWorkspaceId, `KB-全局矩阵-${suffix}`);
    const devGlobalList = expectNoErrors(
      await gql<{ knowledgeBases: any[] }>(KB_LIST, undefined, developer.token, normalWorkspaceId),
    ).knowledgeBases;
    expect(devGlobalList.find((item) => item.id === globalKb.id)?.global).toBe(true);
    expectError(
      await gql(UPDATE_DOC, { knowledgeBaseId: globalKb.id, path: '/g', input: docInput() }, developer.token, normalWorkspaceId),
      'knowledge base permission denied',
    );
    await setPermission(owner.token, globalWorkspaceId, globalKb.id, 'UPDATE_ONLY');
    await createDocument(developer.token, normalWorkspaceId, globalKb.id, '/g', docInput());

    // outsider（其他租户）：既看不到也改不了；跨租户工作区头 workspace not found
    const outsiderList = expectNoErrors(
      await gql<{ knowledgeBases: any[] }>(KB_LIST, undefined, outsider.token),
    ).knowledgeBases;
    expect(outsiderList.map((item) => item.id)).not.toContain(kb.id);
    expectError(
      await gql(KB_LIST, undefined, outsider.token, normalWorkspaceId),
      'workspace not found',
    );
    expectError(
      await gql(UPDATE_DOC, { knowledgeBaseId: kb.id, path: '/n', input: docInput() }, outsider.token),
      'knowledge base not found',
    );
  });

  // -------------------------------------------------------------------------
  // T-KB-API5 MCP（fake controller relay）
  // -------------------------------------------------------------------------

  it('T-KB-API5: 平台 MCP 经 fake controller relay（门控/六工具/越权/name 解析）', async () => {
    // 管理端会话（owner = team admin）
    const adminController = await registerFakeController(
      owner.token,
      `kb-admin-${suffix}`,
      normalWorkspaceId,
    );
    const adminProject = await createControllerWorkspace(
      owner.token,
      adminController.controllerId,
      normalWorkspaceId,
    );
    const adminSession = await createSessionWithMcp(
      owner.token,
      adminController.client,
      adminController.controllerId,
      adminProject,
      normalWorkspaceId,
    );

    const adminList = await relayTool(adminController.client, adminSession.id, adminSession.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const adminTools = (adminList.body.result?.tools ?? []).map((tool: any) => tool.name);
    expect(adminTools).toContain('knowledge_base_create');
    expect(adminTools).toEqual(
      expect.arrayContaining([
        'knowledge_base_list',
        'knowledge_base_document_list',
        'knowledge_base_document_get',
        'knowledge_base_document_update',
        'knowledge_base_document_delete',
      ]),
    );

    // 创建库（admin 通过工具；默认模式 NONE）
    const createdKb = await relayTool(adminController.client, adminSession.id, adminSession.token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'knowledge_base_create', arguments: { name: `MCP库-${suffix}` } },
    });
    expect(createdKb.body.result?.isError).toBeFalsy();
    const mcpKb = JSON.parse(createdKb.body.result.content[0].text);
    expect(mcpKb.permissionMode).toBe('NONE');
    expect(mcpKb.global).toBe(false);

    // 开发端会话（developer）
    const devController = await registerFakeController(
      developer.token,
      `kb-dev-${suffix}`,
      normalWorkspaceId,
    );
    const devProject = await createControllerWorkspace(
      developer.token,
      devController.controllerId,
      normalWorkspaceId,
    );
    const devSession = await createSessionWithMcp(
      developer.token,
      devController.client,
      devController.controllerId,
      devProject,
      normalWorkspaceId,
    );

    const devList = await relayTool(devController.client, devSession.id, devSession.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const devTools = (devList.body.result?.tools ?? []).map((tool: any) => tool.name);
    expect(devTools).not.toContain('knowledge_base_create');
    expect(devTools).toHaveLength(5);

    // developer 直接调 knowledge_base_create → isError not a tenant admin（双校验）
    const deniedCreate = await relayTool(devController.client, devSession.id, devSession.token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'knowledge_base_create', arguments: { name: 'x' } },
    });
    expect(deniedCreate.body.result?.isError).toBe(true);
    expect(deniedCreate.body.result.content[0].text).toBe('not a tenant admin');

    // NONE：developer list 不含该库
    const devKbList = await relayTool(devController.client, devSession.id, devSession.token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'knowledge_base_list', arguments: {} },
    });
    const visibleForDev = JSON.parse(devKbList.body.result.content[0].text);
    expect(visibleForDev.map((item: any) => item.id)).not.toContain(mcpKb.id);

    // 收紧/放开即时生效 → UPDATE_ONLY
    await setPermission(owner.token, normalWorkspaceId, mcpKb.id, 'UPDATE_ONLY');

    const devKbList2 = await relayTool(devController.client, devSession.id, devSession.token, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'knowledge_base_list', arguments: {} },
    });
    const visibleAfter = JSON.parse(devKbList2.body.result.content[0].text);
    expect(visibleAfter.find((item: any) => item.id === mcpKb.id)).toMatchObject({
      name: `MCP库-${suffix}`,
      permissionMode: 'UPDATE_ONLY',
    });
    for (const item of visibleAfter) {
      expect(Object.keys(item).sort()).toEqual(['global', 'id', 'myAccess', 'name', 'permissionMode']);
    }

    // upsert 创建（CREATE）+ 再次更新（UPDATE）
    const write1 = await relayTool(devController.client, devSession.id, devSession.token, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'knowledge_base_document_update',
        arguments: {
          knowledgeBaseName: `MCP库-${suffix}`,
          path: '/mcp/doc',
          title: 'v1',
          tags: ['a'],
          description: 'd',
          content: 'c1',
        },
      },
    });
    expect(write1.body.result?.isError).toBeFalsy();
    expect(JSON.parse(write1.body.result.content[0].text).path).toBe('/mcp/doc');

    await relayTool(devController.client, devSession.id, devSession.token, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'knowledge_base_document_update',
        arguments: {
          knowledgeBaseId: mcpKb.id,
          path: '/mcp/doc',
          title: 'v2',
          tags: ['a'],
          description: 'd',
          content: 'c2',
        },
      },
    });

    // document_list 无 content；get 完整内容
    const mcpDocs = await relayTool(devController.client, devSession.id, devSession.token, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'knowledge_base_document_list', arguments: { knowledgeBaseId: mcpKb.id } },
    });
    expect(mcpDocs.body.result.content[0].text).not.toContain('c2');
    expect(JSON.parse(mcpDocs.body.result.content[0].text)).toEqual([
      { path: '/mcp/doc', title: 'v2', tags: ['a'], description: 'd', updatedAt: expect.any(String) },
    ]);

    const mcpDoc = await relayTool(devController.client, devSession.id, devSession.token, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'knowledge_base_document_get',
        arguments: { knowledgeBaseId: mcpKb.id, path: '/mcp/doc' },
      },
    });
    expect(JSON.parse(mcpDoc.body.result.content[0].text)).toMatchObject({
      path: '/mcp/doc',
      title: 'v2',
      content: 'c2',
    });

    // MCP newPath（#541）：源存在 → 先移动再更新；历史含 MOVE；创建分支携带 → isError
    const mcpMoved = await relayTool(devController.client, devSession.id, devSession.token, {
      jsonrpc: '2.0',
      id: 81,
      method: 'tools/call',
      params: {
        name: 'knowledge_base_document_update',
        arguments: {
          knowledgeBaseId: mcpKb.id,
          path: '/mcp/doc',
          newPath: '/mcp/moved',
          title: 'v2',
          tags: ['a'],
          description: 'd',
          content: 'c2',
        },
      },
    });
    expect(mcpMoved.body.result?.isError).toBeFalsy();
    expect(JSON.parse(mcpMoved.body.result.content[0].text).path).toBe('/mcp/moved');

    const mcpMovedEvents = expectNoErrors(
      await gql<{ knowledgeBaseEvents: any[] }>(
        KB_EVENTS,
        { knowledgeBaseId: mcpKb.id, path: '/mcp/moved' },
        owner.token,
        normalWorkspaceId,
      ),
    ).knowledgeBaseEvents;
    expect(mcpMovedEvents.map((event) => event.op)).toEqual(['MOVE', 'UPDATE', 'CREATE']);
    expect(mcpMovedEvents[0].fromPath).toBe('/mcp/doc');

    const mcpCreateWithNewPath = await relayTool(devController.client, devSession.id, devSession.token, {
      jsonrpc: '2.0',
      id: 82,
      method: 'tools/call',
      params: {
        name: 'knowledge_base_document_update',
        arguments: {
          knowledgeBaseId: mcpKb.id,
          path: '/mcp/brand-new',
          newPath: '/mcp/elsewhere',
          title: 'v1',
          tags: [],
          description: '',
          content: '',
        },
      },
    });
    expect(mcpCreateWithNewPath.body.result?.isError).toBe(true);
    expect(mcpCreateWithNewPath.body.result.content[0].text).toBe(
      'knowledge base document not found',
    );

    // UPDATE_ONLY：删除拒绝
    const deniedDelete = await relayTool(devController.client, devSession.id, devSession.token, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'knowledge_base_document_delete',
        arguments: { knowledgeBaseId: mcpKb.id, path: '/mcp/moved' },
      },
    });
    expect(deniedDelete.body.result?.isError).toBe(true);
    expect(deniedDelete.body.result.content[0].text).toBe('knowledge base permission denied');

    // FULL_ACCESS：删除成功
    await setPermission(owner.token, normalWorkspaceId, mcpKb.id, 'FULL_ACCESS');
    const deleted = await relayTool(devController.client, devSession.id, devSession.token, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'knowledge_base_document_delete',
        arguments: { knowledgeBaseId: mcpKb.id, path: '/mcp/moved' },
      },
    });
    expect(JSON.parse(deleted.body.result.content[0].text)).toEqual({ success: true });

    // name 0 命中；多命中（本工作区 + 全局同名）
    const missing = await relayTool(devController.client, devSession.id, devSession.token, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'knowledge_base_document_list', arguments: { knowledgeBaseName: '不存在' } },
    });
    expect(missing.body.result?.isError).toBe(true);
    expect(missing.body.result.content[0].text).toContain('knowledge base not found: 不存在');

    const dupName = `MCP重名-${suffix}`;
    const normalDup = await createKnowledgeBase(owner.token, normalWorkspaceId, dupName);
    await createKnowledgeBase(owner.token, globalWorkspaceId, dupName);
    await setPermission(owner.token, normalWorkspaceId, normalDup.id, 'FULL_ACCESS');
    const ambiguous = await relayTool(devController.client, devSession.id, devSession.token, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'knowledge_base_document_list', arguments: { knowledgeBaseName: dupName } },
    });
    expect(ambiguous.body.result?.isError).toBe(true);
    expect(ambiguous.body.result.content[0].text).toContain('multiple knowledge bases named');

    // 清理会话
    for (const [client, sessionId, token] of [
      [adminController.client, adminSession.id, owner.token],
      [devController.client, devSession.id, developer.token],
    ] as const) {
      await gql(CLOSE_SESSION, { id: sessionId }, token).catch(() => undefined);
      client.disconnect();
    }
  }, 180_000);

  // -------------------------------------------------------------------------
  // T-KB-API6 校验矩阵
  // -------------------------------------------------------------------------

  it('T-KB-API6: 路径与输入校验矩阵逐字（白名单全覆盖）', async () => {
    // 非法库名（0/65）
    expectError(
      await gql(CREATE_KB, { name: '' }, owner.token, normalWorkspaceId),
      'invalid knowledge base name',
    );
    expectError(
      await gql(CREATE_KB, { name: 'n'.repeat(65) }, owner.token, normalWorkspaceId),
      'invalid knowledge base name',
    );

    // developer 建库 → not a tenant admin
    expectError(
      await gql(CREATE_KB, { name: `禁止-${suffix}` }, developer.token, normalWorkspaceId),
      'not a tenant admin',
    );

    const kb = await createKnowledgeBase(owner.token, normalWorkspaceId, `KB-校验-${suffix}`);
    await setPermission(owner.token, normalWorkspaceId, kb.id, 'FULL_ACCESS');

    // 非法路径
    for (const path of ['no-slash', '/a//b', `/${'x'.repeat(129)}`]) {
      expectError(
        await gql(
          UPDATE_DOC,
          { knowledgeBaseId: kb.id, path, input: docInput() },
          owner.token,
          normalWorkspaceId,
        ),
        'invalid document path',
      );
    }

    // 输入边界
    const invalidInputs: Array<[Record<string, unknown>, string]> = [
      [docInput({ title: '' }), 'invalid document title'],
      [docInput({ title: 't'.repeat(201) }), 'invalid document title'],
      [docInput({ tags: Array.from({ length: 17 }, (_, i) => `t-${i}`) }), 'invalid document tags'],
      [docInput({ tags: ['t'.repeat(33)] }), 'invalid document tags'],
      [docInput({ description: 'd'.repeat(1025) }), 'invalid document description'],
      [docInput({ content: 'c'.repeat(262_145) }), 'invalid document content'],
    ];
    for (const [input, message] of invalidInputs) {
      expectError(
        await gql(
          UPDATE_DOC,
          { knowledgeBaseId: kb.id, path: '/valid', input },
          owner.token,
          normalWorkspaceId,
        ),
        message,
      );
    }

    // 重复路径
    const dupTitle = `/dup-${suffix}`;
    await createDocument(owner.token, normalWorkspaceId, kb.id, dupTitle, docInput());
    expectError(
      await gql(
        CREATE_DOC,
        { knowledgeBaseId: kb.id, path: dupTitle, input: docInput() },
        owner.token,
        normalWorkspaceId,
      ),
      'knowledge base document already exists',
    );

    // 更新/删除不存在
    expectError(
      await gql(
        UPDATE_DOC,
        { knowledgeBaseId: kb.id, path: '/missing', input: docInput() },
        owner.token,
        normalWorkspaceId,
      ),
      'knowledge base document not found',
    );
    expectError(
      await gql(
        DELETE_DOC,
        { knowledgeBaseId: kb.id, path: '/missing' },
        owner.token,
        normalWorkspaceId,
      ),
      'knowledge base document not found',
    );

    // 知识库不存在（写操作）
    expectError(
      await gql(
        UPDATE_DOC,
        { knowledgeBaseId: '507f1f77bcf86cd799439999', path: '/a', input: docInput() },
        owner.token,
        normalWorkspaceId,
      ),
      'knowledge base not found',
    );
  });
});

// ---------------------------------------------------------------------------
// fake controller / relay helpers（对齐 tests/api/src/agent-api/session.test.ts:2263-2369）
// ---------------------------------------------------------------------------

interface FakeController {
  client: ClientSocket;
  controllerId: string;
}

interface StartEvent {
  requestId: string;
  sessionId: string;
  mcpEndpoint?: { token: string; serverNames: string[] };
}

function waitForEvent<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function createControllerClient(): ClientSocket {
  return SocketIOClient(CONTROLLER_API_URL, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

async function registerFakeController(
  token: string,
  hostname: string,
  tenantWorkspaceId?: string,
): Promise<FakeController> {
  const keyResult = expectNoErrors(
    await gql<{ createControllerKey: { rawKey: string; key: { id: string } } }>(
      CREATE_CONTROLLER_KEY,
      { input: { name: `kb-key-${hostname}`, type: 'local' } },
      token,
      tenantWorkspaceId,
    ),
  );
  const client = createControllerClient();
  // 与真实 controller 一致：收到 acp:stop 立即 ack，避免删除会话等待超时
  client.on('acp:stop', (data: { sessionId: string }) => {
    client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_delete' });
  });
  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', {
    key: keyResult.createControllerKey.rawKey,
    hostname,
    version: '2.0.0',
    homeDir: '/home/fake',
    platform: 'linux',
  });
  const reg = await registered;
  return { client, controllerId: reg.controllerId };
}

async function createControllerWorkspace(
  token: string,
  controllerId: string,
  tenantWorkspaceId?: string,
): Promise<string> {
  const path = `/tmp/kb-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const result = expectNoErrors(
    await gql<{ createWorkspace: { id: string } }>(
      CREATE_CONTROLLER_WORKSPACE,
      { input: { controllerId, path } },
      token,
      tenantWorkspaceId,
    ),
  );
  return result.createWorkspace.id;
}

async function createSessionWithMcp(
  token: string,
  client: ClientSocket,
  controllerId: string,
  workspaceId: string,
  tenantWorkspaceId: string,
): Promise<{ id: string; token: string; serverNames: string[] }> {
  const startPromise = waitForEvent<StartEvent>(client, 'acp:start', 30000);
  const result = expectNoErrors(
    await gql<{ createSession: { session: { id: string } } }>(
      CREATE_SESSION,
      {
        input: {
          controllerId,
          acpServerType: 'opencode',
          workspaceId,
          mcpServerIds: [],
        },
      },
      token,
      tenantWorkspaceId,
    ),
  );
  const sessionId = result.createSession.session.id;
  const start = await startPromise;
  expect(start.mcpEndpoint, '平台恒装配服务应签发 mcpEndpoint').toBeTruthy();
  expect(start.mcpEndpoint!.serverNames).toContain('agent-knowledge-base-tools');
  client.emit('acp:start:result', {
    requestId: start.requestId,
    sessionId,
    success: true,
    externalSessionId: `ext_${sessionId}`,
  });
  return {
    id: sessionId,
    token: start.mcpEndpoint!.token,
    serverNames: start.mcpEndpoint!.serverNames,
  };
}

async function relayTool(
  client: ClientSocket,
  sessionId: string,
  token: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const requestId = `mcpreq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('mcp:response', onResponse);
      reject(new Error('MCP relay timeout'));
    }, 30_000);
    const onResponse = (data: { requestId: string; status: number; body: any }) => {
      if (data.requestId !== requestId) return;
      clearTimeout(timer);
      client.off('mcp:response', onResponse);
      resolve({ status: data.status, body: data.body });
    };
    client.on('mcp:response', onResponse);
    client.emit('mcp:request', {
      requestId,
      sessionId,
      serverName: 'agent-knowledge-base-tools',
      token,
      body,
    });
  });
}
