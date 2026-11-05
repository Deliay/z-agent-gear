import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { createFrontUser, type FrontUser } from '../support/front-users.js';

/**
 * 自定义 MCP 集成测试（MCP+Valut Phase 5 / 计划测试矩阵 API-CMCP）。
 *
 * - T-CMCP：CRUD 与 bearer 两路径联动（entry 落 `service-mcp-bearer-tokens`、
 *   引用仅 manual、删除级联/仅删 ref、校验白名单逐字、工作区权限矩阵与 Valut 同口径）；
 * - T-CF1：会话创建携带 `customMcpServerIds`——不可见/非法 id 拒绝且不建会话、
 *   可见 id 快照落库、custom-only（显式 `mcpServerIds: []`）可签发；
 * - T-CF3~5：转发鉴权/失效矩阵——mock 真实 HTTP endpoint（200 注入 bearer + 同名多值
 *   header、name 不在作用域 200+SERVER_NOT_FOUND、通知 202、删除后 410、不可达 502、
 *   会话终态 401），全链路（acp:start / 会话查询 / mcp:response）无凭据明文。
 *
 * 前置：agent-api + controller-api + Redis 就绪（Aspire）、`INTERNAL_API_TOKEN`（开户）；
 * `MONGODB_URI` 可选（endpoint 快照落库断言）。fake controller 走真实 Socket.IO relay。
 * 契约：`contracts/custom-mcp.graphql` + `contracts/agent-session.graphql`。
 */

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const AGENT_API_BASE = API_URL.replace(/\/graphql\/?$/, '');
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

type GqlResult = { data?: any; errors?: Array<{ message: string }> };

async function gql(
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
  workspaceId?: string,
): Promise<GqlResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (workspaceId) headers['x-workspace-id'] = workspaceId;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as GqlResult;
}

async function internalJson(
  path: string,
  method: 'POST' | 'DELETE',
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) throw new Error('custom-mcp API tests require INTERNAL_API_TOKEN');
  const res = await fetch(`${AGENT_API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 保留原始文本便于排查
  }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// GraphQL 文档
// ---------------------------------------------------------------------------

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

const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) { session { id status acpServerType } }
  }
`;

const CLOSE_SESSION = `
  mutation CloseSession($id: ID!) { closeSession(id: $id) }
`;

const SESSIONS = `
  query Sessions { sessions { id status } }
`;

const SESSION_QUERY = `
  query Session($id: ID!) { session(id: $id) { id status acpServerType } }
`;

const REFRESH_CAPABILITIES = `
  mutation RefreshAcpCapabilities($controllerId: ID!) {
    refreshAcpCapabilities(controllerId: $controllerId) { type available }
  }
`;

const CREATE_MCP = `
  mutation CreateCustomMcpServer($input: CreateCustomMcpServerInput!) {
    createCustomMcpServer(input: $input) {
      id name description endpoint authType
      customHeaders { key values }
      bearerEntryId bearerEntryManaged workspaceId createdBy createdAt updatedAt
    }
  }
`;

const UPDATE_MCP = `
  mutation UpdateCustomMcpServer($id: ID!, $input: UpdateCustomMcpServerInput!) {
    updateCustomMcpServer(id: $id, input: $input) {
      id name description endpoint authType
      customHeaders { key values }
      bearerEntryId bearerEntryManaged workspaceId
    }
  }
`;

const DELETE_MCP = `
  mutation DeleteCustomMcpServer($id: ID!) { deleteCustomMcpServer(id: $id) }
`;

const LIST_MCP = `
  query CustomMcpServers {
    customMcpServers {
      id name endpoint authType
      customHeaders { key values }
      bearerEntryId bearerEntryManaged workspaceId
    }
  }
`;

const GET_MCP = `
  query CustomMcpServer($id: ID!) {
    customMcpServer(id: $id) { id name endpoint authType bearerEntryId bearerEntryManaged }
  }
`;

const CREATE_VALUT = `
  mutation CreateValutEntry($input: CreateValutEntryInput!) {
    createValutEntry(input: $input) { id namespace key editable deletable refs { feature refId refLabel } }
  }
`;

const VALUT_ENTRIES = `
  query ValutEntries {
    valutEntries {
      namespace { name displayName managed }
      entries { id namespace key editable deletable refs { feature refId refLabel } }
    }
  }
`;

const CREATE_TENANT_WORKSPACE = `
  mutation CreateTenantWorkspace($name: String!) {
    createTenantWorkspace(name: $name) { id name type }
  }
`;

const ADD_TENANT_WORKSPACE_MEMBER = `
  mutation AddTenantWorkspaceMember($workspaceId: ID!, $userId: ID!) {
    addTenantWorkspaceMember(workspaceId: $workspaceId, userId: $userId) { id memberCount }
  }
`;

// ---------------------------------------------------------------------------
// 断言 / 工具助手
// ---------------------------------------------------------------------------

function collectStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out);
  } else if (node && typeof node === 'object') {
    for (const item of Object.values(node)) collectStrings(item, out);
  }
  return out;
}

function expectNoPlaintext(payload: unknown, sentinel: string): void {
  for (const text of collectStrings(payload)) {
    expect(text, `plaintext leaked: ${text.slice(0, 200)}`).not.toContain(sentinel);
  }
}

function findGroup(groups: any[], name: string): any | undefined {
  return groups.find((group) => group?.namespace?.name === name);
}

function findValutEntry(groups: any[], id: string): any | undefined {
  for (const group of groups ?? []) {
    const hit = (group?.entries ?? []).find((entry: { id: string }) => entry.id === id);
    if (hit) return hit;
  }
  return undefined;
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

interface StartEvent {
  requestId: string;
  sessionId: string;
  mcpEndpoint?: { token: string; serverNames: string[] };
}

interface FakeController {
  client: ClientSocket;
  controllerId: string;
}

/** 注册 fake controller 并保持连接；自动应答 acp:check / git:check / acp:stop。 */
async function registerFakeController(
  token: string,
  tag: string,
  workspaceId?: string,
): Promise<FakeController> {
  const keyRes = await gql(
    CREATE_KEY,
    { input: { name: `cmcp-${tag}-${Date.now()}`, type: 'local' } },
    token,
    workspaceId,
  );
  expect(keyRes.errors, JSON.stringify(keyRes.errors)).toBeUndefined();
  const rawKey = keyRes.data.createControllerKey.rawKey as string;

  const client = SocketIOClient(CONTROLLER_API_URL, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  const heartbeat = setInterval(() => {
    if (client.connected) client.emit('heartbeat');
  }, 30_000);
  client.on('disconnect', () => clearInterval(heartbeat));
  client.on('acp:check', (data: { requestId: string }) => {
    client.emit('acp:check:result', {
      requestId: data.requestId,
      servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
    });
  });
  client.on('git:check', (data: { requestId: string }) => {
    client.emit('git:check:result', { requestId: data.requestId, isGitRepo: false });
  });
  client.on('acp:stop', (data: { sessionId: string }) => {
    client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_close' });
  });

  const registered = waitForEvent<{ controllerId: string }>(client, 'registered', 10000);
  client.emit('register', {
    key: rawKey,
    hostname: `cmcp-${tag}-host`,
    version: '2.0.0',
    homeDir: '/home/fake',
    platform: 'linux',
  });
  const reg = await registered;
  return { client, controllerId: reg.controllerId };
}

/** 经 fake controller 主 WebSocket 走 MCP relay（mcp:request → mcp:response）。 */
async function relayCall(
  socket: ClientSocket,
  sessionId: string,
  serverName: string,
  token: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const requestId = `mcpreq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('mcp:response', onResponse);
      reject(new Error(`MCP relay timeout for ${serverName}`));
    }, 20000);
    const onResponse = (data: { requestId: string; status: number; body: any }) => {
      if (data.requestId !== requestId) return;
      clearTimeout(timer);
      socket.off('mcp:response', onResponse);
      resolve({ status: data.status, body: data.body });
    };
    socket.on('mcp:response', onResponse);
    socket.emit('mcp:request', { requestId, sessionId, serverName, token, body });
  });
}

/** 收集 rawHeaders 中某 header 的全部值（同名多值可能分行或逗号合并）。 */
function headerValues(rawHeaders: string[], name: string): string[] {
  const out: string[] = [];
  const lower = name.toLowerCase();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() === lower) out.push(String(rawHeaders[i + 1]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 真实 HTTP endpoint（mock）：记录收到的请求并回 JSON-RPC 响应
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  body: string;
}

const recorded: RecordedRequest[] = [];
let httpServer: Server | null = null;
let httpPort = 0;

async function startEndpointServer(): Promise<number> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      recorded.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawHeaders: [...req.rawHeaders],
        body,
      });
      let rpcId: unknown = null;
      try {
        rpcId = (JSON.parse(body) as { id?: unknown })?.id ?? null;
      } catch {
        rpcId = null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: { tools: [], ok: true } }));
    });
  });
  httpServer = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  httpPort = (server.address() as AddressInfo).port;
  return httpPort;
}

// ---------------------------------------------------------------------------
// 夹具（T-WS 模式：team 租户 + admin/developer/outsider + 普通工作区）
// ---------------------------------------------------------------------------

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

let admin: FrontUser;
let developer: FrontUser;
let outsider: FrontUser;
let teamId = '';
let teamGlobalId = '';
let ws1 = '';
let devFake: FakeController | null = null;
let projectWorkspaceId = '';

/** T-CMCP 夹具（普通工作区 ws1，developer 创建）。 */
let managedMcpId = '';
let managedEntryId = '';
let managedToken = '';
let manualEntryId = '';
let refMcp1Id = '';
let refMcp2Id = '';
/** T-CMCP-P：admin 在团队全局工作区创建（跨工作区对照 + 不可见 id 用例）。 */
let globalMcpId = '';
/** T-CF1：custom-only 会话（可见 id）。 */
let cfSessionId = '';
let cfMcpId = '';
let cfMcpName = '';
let cfBearerToken = '';
let cfStartEvent: StartEvent | null = null;
/** T-CF4/CF3：不可达 endpoint 会话（502）与终态会话（401）。 */
let badSessionId = '';
let badMcpName = '';
let badMcpId = '';

describe('Custom MCP API（API-CMCP / T-CMCP / T-CF）', () => {
  beforeAll(async () => {
    admin = await createFrontUser();
    developer = await createFrontUser();
    outsider = await createFrontUser();

    const team = await internalJson('/internal/tenants', 'POST', { name: `cmcp-${suffix}`.slice(0, 60) });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    teamId = team.body.tenant.id;
    teamGlobalId = team.body.globalWorkspace.id;

    for (const [username, role] of [
      [admin.username, 'admin'],
      [developer.username, 'developer'],
    ] as const) {
      const added = await internalJson(`/internal/tenants/${teamId}/members`, 'POST', { username, role });
      expect([200, 201], JSON.stringify(added.body)).toContain(added.status);
    }

    const created = await gql(
      CREATE_TENANT_WORKSPACE,
      { name: `cmcp-normal-${suffix}` },
      admin.token,
      teamGlobalId,
    );
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    ws1 = created.data.createTenantWorkspace.id;

    const joined = await gql(
      ADD_TENANT_WORKSPACE_MEMBER,
      { workspaceId: ws1, userId: developer.userId },
      admin.token,
      teamGlobalId,
    );
    expect(joined.errors, JSON.stringify(joined.errors)).toBeUndefined();

    // 控制器/key 落在普通工作区上下文（controller.workspaceId 继承自 key）
    devFake = await registerFakeController(developer.token, 'dev', ws1);
    const caps = await gql(REFRESH_CAPABILITIES, { controllerId: devFake.controllerId }, developer.token, ws1);
    expect(caps.errors, JSON.stringify(caps.errors)).toBeUndefined();

    const project = await gql(
      CREATE_WORKSPACE,
      { input: { controllerId: devFake.controllerId, path: `/tmp/cmcp-${suffix}` } },
      developer.token,
      ws1,
    );
    expect(project.errors, JSON.stringify(project.errors)).toBeUndefined();
    projectWorkspaceId = project.data.createWorkspace.id;

    await startEndpointServer();
  }, 120_000);

  afterAll(async () => {
    devFake?.client.disconnect();
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }
  });

  // -------------------------------------------------------------------------
  // T-CMCP：CRUD 与 bearer 两路径联动
  // -------------------------------------------------------------------------

  it('T-CMCP-C1: none 路径 CRUD 与视图白名单（无 token 出参、不存在 id null、重名拒绝）', async () => {
    const name = `cmcp-none-${suffix}`;
    const created = await gql(
      CREATE_MCP,
      {
        input: {
          name,
          description: 'none path',
          endpoint: 'http://127.0.0.1:9/mcp',
          auth: { type: 'none' },
          customHeaders: [{ key: 'X-Tag', values: ['a', 'b'] }],
        },
      },
      developer.token,
      ws1,
    );
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    const mcp = created.data.createCustomMcpServer;
    expect(mcp).toMatchObject({
      name,
      description: 'none path',
      endpoint: 'http://127.0.0.1:9/mcp',
      authType: 'none',
      bearerEntryId: null,
      bearerEntryManaged: null,
      workspaceId: ws1,
      createdBy: developer.userId,
    });
    expect(mcp.customHeaders).toEqual([{ key: 'X-Tag', values: ['a', 'b'] }]);
    expect(Object.keys(mcp)).not.toContain('token');
    expect(Object.keys(mcp)).not.toContain('newToken');
    expect(typeof mcp.createdAt).toBe('string');
    expect(typeof mcp.updatedAt).toBe('string');

    const list = await gql(LIST_MCP, undefined, developer.token, ws1);
    expect(list.errors, JSON.stringify(list.errors)).toBeUndefined();
    expect(list.data.customMcpServers.some((row: { id: string }) => row.id === mcp.id)).toBe(true);

    const one = await gql(GET_MCP, { id: mcp.id }, developer.token, ws1);
    expect(one.errors, JSON.stringify(one.errors)).toBeUndefined();
    expect(one.data.customMcpServer.id).toBe(mcp.id);

    // 不存在 id → null（契约可空出参）
    const missing = await gql(GET_MCP, { id: '000000000000000000000000' }, developer.token, ws1);
    expect(missing.errors, JSON.stringify(missing.errors)).toBeUndefined();
    expect(missing.data.customMcpServer).toBeNull();

    // 工作区内重名 → invalid mcp name（白名单逐字）
    const duplicate = await gql(
      CREATE_MCP,
      { input: { name, endpoint: 'http://127.0.0.1:9/mcp', auth: { type: 'none' } } },
      developer.token,
      ws1,
    );
    expect(duplicate.errors?.[0]?.message).toBe('invalid mcp name');

    const deleted = await gql(DELETE_MCP, { id: mcp.id }, developer.token, ws1);
    expect(deleted.errors, JSON.stringify(deleted.errors)).toBeUndefined();
    expect(deleted.data.deleteCustomMcpServer).toBe(true);
    const after = await gql(LIST_MCP, undefined, developer.token, ws1);
    expect(after.data.customMcpServers.some((row: { id: string }) => row.id === mcp.id)).toBe(false);
  });

  it('T-CMCP-C2: 校验矩阵逐字命中白名单（name/endpoint/headers/auth/引用非 manual）', async () => {
    const endpoint = 'http://127.0.0.1:9/mcp';
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['name 空', { name: '', endpoint, auth: { type: 'none' } }, 'invalid mcp name'],
      ['name 超 64', { name: 'x'.repeat(65), endpoint, auth: { type: 'none' } }, 'invalid mcp name'],
      ['endpoint 非 URL', { name: 'v-bad-url', endpoint: 'not-a-url', auth: { type: 'none' } }, 'invalid mcp endpoint'],
      ['endpoint 非 http(s)', { name: 'v-bad-scheme', endpoint: 'ftp://example.com/mcp', auth: { type: 'none' } }, 'invalid mcp endpoint'],
      ['header key 含冒号', { name: 'v-h1', endpoint, auth: { type: 'none' }, customHeaders: [{ key: 'X:Y', values: ['v'] }] }, 'invalid custom headers'],
      ['header key 重复', { name: 'v-h2', endpoint, auth: { type: 'none' }, customHeaders: [{ key: 'X-A', values: ['1'] }, { key: 'X-A', values: ['2'] }] }, 'invalid custom headers'],
      ['header values 空', { name: 'v-h3', endpoint, auth: { type: 'none' }, customHeaders: [{ key: 'X-A', values: [] }] }, 'invalid custom headers'],
      ['header 超 32 条', { name: 'v-h4', endpoint, auth: { type: 'none' }, customHeaders: Array.from({ length: 33 }, (_, i) => ({ key: `X-K${i}`, values: ['v'] })) }, 'invalid custom headers'],
      ['bearer 缺 token', { name: 'v-b1', endpoint, auth: { type: 'bearer' } }, 'bearer token is required'],
    ];
    for (const [label, input, message] of cases) {
      const res = await gql(CREATE_MCP, { input }, developer.token, ws1);
      expect(res.errors?.[0]?.message, label).toBe(message);
    }

    // auth type 非法：GraphQL 枚举层即拒绝（schema 严于服务层白名单，服务层
    // `invalid mcp auth type` → `internal error` 的收敛由单测覆盖）
    const badAuth = await gql(
      CREATE_MCP,
      { input: { name: 'v-b2', endpoint, auth: { type: 'digest' } } },
      developer.token,
      ws1,
    );
    expect(badAuth.errors?.[0]?.message).toContain('does not exist in "CustomMcpAuthType" enum');

    // 引用非 manual 条目（service-*）→ bearer entry must be manual namespace；失败不留 MCP
    const throwawayToken = `CMCP_THROWAWAY_${suffix}`;
    const throwaway = await gql(
      CREATE_MCP,
      { input: { name: `cmcp-throwaway-${suffix}`, endpoint, auth: { type: 'bearer', newToken: throwawayToken } } },
      developer.token,
      ws1,
    );
    expect(throwaway.errors, JSON.stringify(throwaway.errors)).toBeUndefined();
    const throwawayEntryId = throwaway.data.createCustomMcpServer.bearerEntryId as string;

    const badRefName = `cmcp-badref-${suffix}`;
    const badRef = await gql(
      CREATE_MCP,
      { input: { name: badRefName, endpoint, auth: { type: 'bearer', existingEntryId: throwawayEntryId } } },
      developer.token,
      ws1,
    );
    expect(badRef.errors?.[0]?.message).toBe('bearer entry must be manual namespace');
    const afterBad = await gql(LIST_MCP, undefined, developer.token, ws1);
    expect(afterBad.data.customMcpServers.some((row: { name: string }) => row.name === badRefName)).toBe(false);

    await gql(DELETE_MCP, { id: throwaway.data.createCustomMcpServer.id }, developer.token, ws1);
  });

  it('T-CMCP-C3: bearer+newToken —— entry 落 service-mcp-bearer-tokens、editable/deletable、ref 指向 MCP、响应无 token 明文', async () => {
    const name = `cmcp-bearer-${suffix}`;
    managedToken = `CMCP_NEW_TOKEN_${suffix}`;
    const created = await gql(
      CREATE_MCP,
      { input: { name, endpoint: 'http://127.0.0.1:9/mcp', auth: { type: 'bearer', newToken: managedToken } } },
      developer.token,
      ws1,
    );
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    const mcp = created.data.createCustomMcpServer;
    managedMcpId = mcp.id as string;
    managedEntryId = mcp.bearerEntryId as string;
    expect(mcp.authType).toBe('bearer');
    expect(managedEntryId).toBeTruthy();
    expect(mcp.bearerEntryManaged).toBe(true);
    expectNoPlaintext(created, managedToken);

    const groups = await gql(VALUT_ENTRIES, undefined, developer.token, ws1);
    expect(groups.errors, JSON.stringify(groups.errors)).toBeUndefined();
    const serviceGroup = findGroup(groups.data.valutEntries, 'service-mcp-bearer-tokens');
    expect(serviceGroup, 'service-mcp-bearer-tokens 分组应存在').toBeDefined();
    const entry = serviceGroup.entries.find((row: { id: string }) => row.id === managedEntryId);
    expect(entry, '自建 token 条目应落 service 分组').toBeDefined();
    expect(entry).toMatchObject({ key: name, editable: true, deletable: false });
    expect(entry.refs).toEqual([{ feature: 'mcp-bearer-tokens', refId: mcp.id, refLabel: name }]);
    expectNoPlaintext(groups, managedToken);
  });

  it('T-CMCP-C4: bearer+existingEntryId —— 仅 manual、仅建 ref、多 MCP 共引同一条目各自独立 ref', async () => {
    const manual = await gql(
      CREATE_VALUT,
      { input: { key: `cmcp-manual-${suffix}`, value: 'manual-secret-value' } },
      developer.token,
      ws1,
    );
    expect(manual.errors, JSON.stringify(manual.errors)).toBeUndefined();
    manualEntryId = manual.data.createValutEntry.id as string;

    const ref1 = await gql(
      CREATE_MCP,
      {
        input: {
          name: `cmcp-ref1-${suffix}`,
          endpoint: 'http://127.0.0.1:9/mcp',
          auth: { type: 'bearer', existingEntryId: manualEntryId },
        },
      },
      developer.token,
      ws1,
    );
    expect(ref1.errors, JSON.stringify(ref1.errors)).toBeUndefined();
    refMcp1Id = ref1.data.createCustomMcpServer.id as string;
    expect(ref1.data.createCustomMcpServer.bearerEntryId).toBe(manualEntryId);
    expect(ref1.data.createCustomMcpServer.bearerEntryManaged).toBe(false);

    const ref2 = await gql(
      CREATE_MCP,
      {
        input: {
          name: `cmcp-ref2-${suffix}`,
          endpoint: 'http://127.0.0.1:9/mcp',
          auth: { type: 'bearer', existingEntryId: manualEntryId },
        },
      },
      developer.token,
      ws1,
    );
    expect(ref2.errors, JSON.stringify(ref2.errors)).toBeUndefined();
    refMcp2Id = ref2.data.createCustomMcpServer.id as string;
    expect(ref2.data.createCustomMcpServer.bearerEntryManaged).toBe(false);

    const groups = await gql(VALUT_ENTRIES, undefined, developer.token, ws1);
    expect(groups.errors, JSON.stringify(groups.errors)).toBeUndefined();
    const entry = findValutEntry(groups.data.valutEntries, manualEntryId);
    expect(entry, 'manual 条目应存在').toBeDefined();
    expect(entry.refs).toHaveLength(2);
    expect(entry.refs.map((ref: { refId: string }) => ref.refId).sort()).toEqual(
      [refMcp1Id, refMcp2Id].sort(),
    );
    expect(entry.refs.map((ref: { feature: string }) => ref.feature)).toEqual([
      'mcp-bearer-tokens',
      'mcp-bearer-tokens',
    ]);
  });

  it('T-CMCP-C5: 编辑 —— 直改字段；manual 引用就地改值拒绝；自建 token 就地更新（不回显）', async () => {
    const renamed = await gql(
      UPDATE_MCP,
      {
        id: refMcp1Id,
        input: {
          name: `cmcp-ref1-r-${suffix}`,
          description: 'updated description',
          endpoint: 'http://127.0.0.1:9/mcp2',
        },
      },
      developer.token,
      ws1,
    );
    expect(renamed.errors, JSON.stringify(renamed.errors)).toBeUndefined();
    expect(renamed.data.updateCustomMcpServer).toMatchObject({
      name: `cmcp-ref1-r-${suffix}`,
      description: 'updated description',
      endpoint: 'http://127.0.0.1:9/mcp2',
      bearerEntryId: manualEntryId,
      bearerEntryManaged: false,
    });

    // manual 引用：bearer+newToken 就地改值拒绝（穿透编辑口径）
    const inPlace = await gql(
      UPDATE_MCP,
      { id: refMcp1Id, input: { auth: { type: 'bearer', newToken: 'should-not-apply' } } },
      developer.token,
      ws1,
    );
    expect(inPlace.errors?.[0]?.message).toBe('bearer entry not editable in place');

    // 自建 token：就地更新值（同一条目，响应不回显 token）
    const rotated = `CMCP_ROTATED_${suffix}`;
    const updated = await gql(
      UPDATE_MCP,
      { id: managedMcpId, input: { auth: { type: 'bearer', newToken: rotated } } },
      developer.token,
      ws1,
    );
    expect(updated.errors, JSON.stringify(updated.errors)).toBeUndefined();
    expect(updated.data.updateCustomMcpServer.bearerEntryId).toBe(managedEntryId);
    expect(updated.data.updateCustomMcpServer.bearerEntryManaged).toBe(true);
    expectNoPlaintext(updated, rotated);

    // auth 省略 = 不动（编辑报文不带 auth 键时条目关联不变）
    const untouched = await gql(
      UPDATE_MCP,
      { id: managedMcpId, input: { description: 'no auth key' } },
      developer.token,
      ws1,
    );
    expect(untouched.errors, JSON.stringify(untouched.errors)).toBeUndefined();
    expect(untouched.data.updateCustomMcpServer.bearerEntryId).toBe(managedEntryId);
    expect(untouched.data.updateCustomMcpServer.description).toBe('no auth key');
  });

  it('T-CMCP-C6: 删除 —— 自建级联删 entry+ref；引用仅删 ref 条目保留；跨工作区 Not found；不存在 not found', async () => {
    // 引用删除：仅解绑 ref，manual 条目保留
    const delRef = await gql(DELETE_MCP, { id: refMcp2Id }, developer.token, ws1);
    expect(delRef.errors, JSON.stringify(delRef.errors)).toBeUndefined();
    expect(delRef.data.deleteCustomMcpServer).toBe(true);

    const afterRef = await gql(VALUT_ENTRIES, undefined, developer.token, ws1);
    expect(afterRef.errors, JSON.stringify(afterRef.errors)).toBeUndefined();
    const kept = findValutEntry(afterRef.data.valutEntries, manualEntryId);
    expect(kept, '引用删除后 manual 条目应保留').toBeDefined();
    expect(kept.refs.map((ref: { refId: string }) => ref.refId)).not.toContain(refMcp2Id);
    expect(kept.refs.map((ref: { refId: string }) => ref.refId)).toContain(refMcp1Id);

    // 自建删除：entry + ref 级联
    const delManaged = await gql(DELETE_MCP, { id: managedMcpId }, developer.token, ws1);
    expect(delManaged.errors, JSON.stringify(delManaged.errors)).toBeUndefined();
    expect(delManaged.data.deleteCustomMcpServer).toBe(true);

    const afterCascade = await gql(VALUT_ENTRIES, undefined, developer.token, ws1);
    const serviceGroup = findGroup(afterCascade.data.valutEntries, 'service-mcp-bearer-tokens');
    const stillThere = serviceGroup
      ? serviceGroup.entries.find((row: { id: string }) => row.id === managedEntryId)
      : undefined;
    expect(stillThere, '自建 token 条目应随 MCP 删除级联消失').toBeUndefined();

    // 跨工作区 id → Not found（admin 在团队全局上下文访问 ws1 的 MCP）
    const crossUpdate = await gql(
      UPDATE_MCP,
      { id: refMcp1Id, input: { description: 'cross' } },
      admin.token,
      teamGlobalId,
    );
    expect(crossUpdate.errors?.[0]?.message).toBe('Not found');
    const crossDelete = await gql(DELETE_MCP, { id: refMcp1Id }, admin.token, teamGlobalId);
    expect(crossDelete.errors?.[0]?.message).toBe('Not found');

    // 不存在 id → custom mcp server not found
    const missingUpdate = await gql(
      UPDATE_MCP,
      { id: '000000000000000000000000', input: { description: 'x' } },
      developer.token,
      ws1,
    );
    expect(missingUpdate.errors?.[0]?.message).toBe('custom mcp server not found');
    const missingDelete = await gql(DELETE_MCP, { id: '000000000000000000000000' }, developer.token, ws1);
    expect(missingDelete.errors?.[0]?.message).toBe('custom mcp server not found');
  });

  it('T-CMCP-P1: 工作区权限矩阵与 Valut 同口径（全局 developer 读通写拒 / admin 写通 / 成员读写 / 非成员与跨工作区）', async () => {
    // 1) 全局工作区：developer 读通
    const devRead = await gql(LIST_MCP, undefined, developer.token, teamGlobalId);
    expect(devRead.errors, JSON.stringify(devRead.errors)).toBeUndefined();

    // 2) 全局工作区：developer 写拒（白名单逐字）
    const devCreate = await gql(
      CREATE_MCP,
      { input: { name: `dev-g-${suffix}`, endpoint: 'http://127.0.0.1:9/mcp', auth: { type: 'none' } } },
      developer.token,
      teamGlobalId,
    );
    expect(devCreate.errors?.[0]?.message).toBe('global workspace is read-only');
    const devDelete = await gql(DELETE_MCP, { id: '000000000000000000000000' }, developer.token, teamGlobalId);
    expect(devDelete.errors?.[0]?.message).toBe('global workspace is read-only');

    // 3) 全局工作区：admin 写通
    const adminCreate = await gql(
      CREATE_MCP,
      { input: { name: `admin-g-${suffix}`, endpoint: 'http://127.0.0.1:9/mcp', auth: { type: 'none' } } },
      admin.token,
      teamGlobalId,
    );
    expect(adminCreate.errors, JSON.stringify(adminCreate.errors)).toBeUndefined();
    globalMcpId = adminCreate.data.createCustomMcpServer.id as string;
    expect(adminCreate.data.createCustomMcpServer.workspaceId).toBe(teamGlobalId);

    // 4) 普通工作区：成员（developer）读写通
    const devNormal = await gql(
      CREATE_MCP,
      { input: { name: `dev-n-${suffix}`, endpoint: 'http://127.0.0.1:9/mcp', auth: { type: 'none' } } },
      developer.token,
      ws1,
    );
    expect(devNormal.errors, JSON.stringify(devNormal.errors)).toBeUndefined();
    const normalMcpId = devNormal.data.createCustomMcpServer.id as string;
    const normalList = await gql(LIST_MCP, undefined, developer.token, ws1);
    expect(normalList.data.customMcpServers.some((row: { id: string }) => row.id === normalMcpId)).toBe(true);

    // admin 作为租户 admin 亦可在普通工作区读写
    const adminNormal = await gql(LIST_MCP, undefined, admin.token, ws1);
    expect(adminNormal.errors, JSON.stringify(adminNormal.errors)).toBeUndefined();
    expect(adminNormal.data.customMcpServers.some((row: { id: string }) => row.id === normalMcpId)).toBe(true);

    // 5) 非成员（outsider）：header 指向团队工作区 → workspace not found
    const outsiderGlobal = await gql(LIST_MCP, undefined, outsider.token, teamGlobalId);
    expect(outsiderGlobal.errors?.[0]?.message).toBe('workspace not found');
    const outsiderCreate = await gql(
      CREATE_MCP,
      { input: { name: `out-${suffix}`, endpoint: 'http://127.0.0.1:9/mcp', auth: { type: 'none' } } },
      outsider.token,
      ws1,
    );
    expect(outsiderCreate.errors?.[0]?.message).toBe('workspace not found');

    // 6) 跨工作区 id → Not found；列表独占（仅当前工作区）
    const crossToWs1 = await gql(GET_MCP, { id: globalMcpId }, developer.token, ws1);
    expect(crossToWs1.errors?.[0]?.message).toBe('Not found');
    const crossToGlobal = await gql(GET_MCP, { id: normalMcpId }, admin.token, teamGlobalId);
    expect(crossToGlobal.errors?.[0]?.message).toBe('Not found');
    const globalList = await gql(LIST_MCP, undefined, admin.token, teamGlobalId);
    expect(globalList.data.customMcpServers.some((row: { id: string }) => row.id === globalMcpId)).toBe(true);
    expect(globalList.data.customMcpServers.some((row: { id: string }) => row.id === normalMcpId)).toBe(false);
    const ws1List = await gql(LIST_MCP, undefined, admin.token, ws1);
    expect(ws1List.data.customMcpServers.some((row: { id: string }) => row.id === globalMcpId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // T-CF1：会话签发 customMcpServerIds
  // -------------------------------------------------------------------------

  it(
    'T-CF1: 会话携带 customMcpServerIds —— 不可见/非法 id 拒绝且不建会话；可见 id 快照落库且 custom-only 可签发',
    async () => {
      cfMcpName = `cf-visible-${suffix}`;
      cfBearerToken = `CF_BEARER_${suffix}`;
      const created = await gql(
        CREATE_MCP,
        {
          input: {
            name: cfMcpName,
            endpoint: `http://127.0.0.1:${httpPort}/mcp`,
            auth: { type: 'bearer', newToken: cfBearerToken },
            customHeaders: [{ key: 'X-Custom-Tag', values: ['tag-a', 'tag-b'] }],
          },
        },
        developer.token,
        ws1,
      );
      expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
      cfMcpId = created.data.createCustomMcpServer.id as string;

      const before = await gql(SESSIONS, undefined, developer.token, ws1);
      expect(before.errors, JSON.stringify(before.errors)).toBeUndefined();
      const beforeCount = before.data.sessions.length;

      const baseInput = {
        controllerId: devFake!.controllerId,
        acpServerType: 'opencode',
        workspaceId: projectWorkspaceId,
        mcpServerIds: [] as string[],
      };

      // 非法 id → custom mcp server not found（建会话前拒绝）
      const invalid = await gql(
        CREATE_SESSION,
        { input: { ...baseInput, customMcpServerIds: ['not-an-objectid'] } },
        developer.token,
        ws1,
      );
      expect(invalid.errors?.[0]?.message).toBe('custom mcp server not found');

      // 不可见 id（团队全局工作区的 MCP，普通工作区上下文不可见）→ 同文案拒绝
      expect(globalMcpId, 'T-CMCP-P1 应先创建全局 MCP').toBeTruthy();
      const invisible = await gql(
        CREATE_SESSION,
        { input: { ...baseInput, customMcpServerIds: [globalMcpId] } },
        developer.token,
        ws1,
      );
      expect(invisible.errors?.[0]?.message).toBe('custom mcp server not found');

      // 两次拒绝均未建会话
      const afterFail = await gql(SESSIONS, undefined, developer.token, ws1);
      expect(afterFail.data.sessions.length).toBe(beforeCount);

      // 可见 id + custom-only（显式 mcpServerIds: []）→ 正常签发
      const startPromise = waitForEvent<StartEvent>(devFake!.client, 'acp:start', 30000);
      const ok = await gql(
        CREATE_SESSION,
        { input: { ...baseInput, customMcpServerIds: [cfMcpId] } },
        developer.token,
        ws1,
      );
      expect(ok.errors, JSON.stringify(ok.errors)).toBeUndefined();
      cfSessionId = ok.data.createSession.session.id as string;

      const start = await startPromise;
      cfStartEvent = start;
      expect(start.sessionId).toBe(cfSessionId);
      expect(start.mcpEndpoint, 'custom-only 会话必须签发 mcpEndpoint').toBeTruthy();
      expect(start.mcpEndpoint!.token).toBeTruthy();
      // 显式 mcpServerIds: [] → serverNames 恰为 custom 名（无个人 MCP 混入）
      expect(start.mcpEndpoint!.serverNames).toEqual([cfMcpName]);
      expectNoPlaintext(JSON.stringify(start), cfBearerToken);

      devFake!.client.emit('acp:start:result', {
        requestId: start.requestId,
        sessionId: start.sessionId,
        success: true,
        externalSessionId: `ext_${suffix}`,
      });

      // 快照落库（可选 MONGODB_URI）：customMcpServers 与 tokenHash 同一次 upsert
      if (HAS_MONGO) {
        if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI!);
        const doc = (await mongoose.connection.db!
          .collection('mcpsessionendpoints')
          .findOne({ sessionId: cfSessionId })) as Record<string, any> | null;
        expect(doc, 'endpoint 快照应落库').toBeTruthy();
        expect(doc!.customMcpServers).toEqual([{ id: cfMcpId, name: cfMcpName }]);
        expect(doc!.status).toBe('active');
        expect(doc!.tokenHash).toBeTruthy();
      }
    },
    90_000,
  );

  // -------------------------------------------------------------------------
  // T-CF3~5：转发鉴权/失效矩阵（mock 真实 HTTP endpoint）
  // -------------------------------------------------------------------------

  it(
    'T-CF4/T-CF5: 转发 200 注入（Bearer + 同名多值 header + body 原样），全链路无凭据明文',
    async () => {
      expect(cfSessionId).toBeTruthy();
      const beforeCount = recorded.length;
      const resp = await relayCall(
        devFake!.client,
        cfSessionId,
        cfMcpName,
        cfStartEvent!.mcpEndpoint!.token,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      );
      expect(resp.status).toBe(200);
      expect(resp.body.result).toBeDefined();
      expect(resp.body.error).toBeUndefined();
      expect(recorded.length, 'mock endpoint 应收到转发请求').toBeGreaterThan(beforeCount);

      const req = recorded[recorded.length - 1];
      expect(req.method).toBe('POST');
      // bearer 解密注入（明文只进请求头）
      expect(req.headers.authorization).toBe(`Bearer ${cfBearerToken}`);
      // customHeaders 同名多值展开（分行或逗号合并均可，两个值必须都在）
      const tags = headerValues(req.rawHeaders, 'X-Custom-Tag').join(',');
      expect(tags).toContain('tag-a');
      expect(tags).toContain('tag-b');
      // JSON-RPC body 原样转发
      const forwarded = JSON.parse(req.body) as { jsonrpc: string; method: string; id: number };
      expect(forwarded).toMatchObject({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

      // 无凭据明文：acp:start 载荷、会话查询、mcp:response 均无 bearer token
      expectNoPlaintext(JSON.stringify(cfStartEvent), cfBearerToken);
      expectNoPlaintext(resp, cfBearerToken);
      const sessionQuery = await gql(SESSION_QUERY, { id: cfSessionId }, developer.token, ws1);
      expectNoPlaintext(sessionQuery, cfBearerToken);
      const mcpList = await gql(LIST_MCP, undefined, developer.token, ws1);
      expectNoPlaintext(mcpList, cfBearerToken);
      const valutList = await gql(VALUT_ENTRIES, undefined, developer.token, ws1);
      expectNoPlaintext(valutList, cfBearerToken);
    },
    60_000,
  );

  it('T-CF3: name 不在会话作用域 → 200 + SERVER_NOT_FOUND；通知（无 id）→ 202', async () => {
    const token = cfStartEvent!.mcpEndpoint!.token;

    const scope = await relayCall(
      devFake!.client,
      cfSessionId,
      'not-assembled-name',
      token,
      { jsonrpc: '2.0', id: 7, method: 'tools/list' },
    );
    expect(scope.status).toBe(200);
    expect(scope.body.error).toBeDefined();
    expect(scope.body.error.code).toBe('SERVER_NOT_FOUND');
    expect(scope.body.error.message).toBe('Server not assembled in this session');

    const notification = await relayCall(
      devFake!.client,
      cfSessionId,
      cfMcpName,
      token,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    );
    expect(notification.status).toBe(202);
  }, 60_000);

  it('T-CF3: 删除自定义 MCP 后全端点即时失效（410）', async () => {
    const token = cfStartEvent!.mcpEndpoint!.token;
    const deleted = await gql(DELETE_MCP, { id: cfMcpId }, developer.token, ws1);
    expect(deleted.errors, JSON.stringify(deleted.errors)).toBeUndefined();
    expect(deleted.data.deleteCustomMcpServer).toBe(true);

    const gone = await relayCall(devFake!.client, cfSessionId, cfMcpName, token, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/list',
    });
    expect(gone.status).toBe(410);
    expect(gone.body.error).toBeDefined();
    expect(gone.body.error.code).toBe('SERVER_NOT_FOUND');
    expect(gone.body.error.message).toBe('Custom MCP server has been deleted');
    // 会话仍 active（410 而非 401，诊断优先级 401 > 作用域 > 410 > 502）
    const stillActive = await relayCall(devFake!.client, cfSessionId, 'not-assembled-name', token, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/list',
    });
    expect(stillActive.status).toBe(200);
    expect(stillActive.body.error.code).toBe('SERVER_NOT_FOUND');
  }, 60_000);

  it('T-CF4: 真实 endpoint 不可达 → 502（报文不回显 endpoint/错误正文）', async () => {
    // 端口 1：连接立即拒绝（不可达语义，不引入 30s 超时等待）
    badMcpName = `cf-unreachable-${suffix}`;
    const bad = await gql(
      CREATE_MCP,
      { input: { name: badMcpName, endpoint: 'http://127.0.0.1:1/mcp', auth: { type: 'none' } } },
      developer.token,
      ws1,
    );
    expect(bad.errors, JSON.stringify(bad.errors)).toBeUndefined();
    badMcpId = bad.data.createCustomMcpServer.id as string;

    const startPromise = waitForEvent<StartEvent>(devFake!.client, 'acp:start', 30000);
    const sessionRes = await gql(
      CREATE_SESSION,
      {
        input: {
          controllerId: devFake!.controllerId,
          acpServerType: 'opencode',
          workspaceId: projectWorkspaceId,
          mcpServerIds: [],
          customMcpServerIds: [badMcpId],
        },
      },
      developer.token,
      ws1,
    );
    expect(sessionRes.errors, JSON.stringify(sessionRes.errors)).toBeUndefined();
    badSessionId = sessionRes.data.createSession.session.id as string;
    const start = await startPromise;
    expect(start.mcpEndpoint!.serverNames).toEqual([badMcpName]);
    const sessionToken = start.mcpEndpoint!.token;
    devFake!.client.emit('acp:start:result', {
      requestId: start.requestId,
      sessionId: start.sessionId,
      success: true,
      externalSessionId: `ext502_${suffix}`,
    });

    const failed = await relayCall(devFake!.client, badSessionId, badMcpName, sessionToken, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/list',
    });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBeDefined();
    expect(failed.body.error.code).toBe('FORWARD_ERROR');
    // 502 报文不回显 endpoint / 真实错误正文
    expect(JSON.stringify(failed)).not.toContain('127.0.0.1:1');
    expect(JSON.stringify(failed)).not.toContain('ECONNREFUSED');
  }, 90_000);

  it('T-CF3: 会话终态（关闭）后转发 401 ENDPOINT_REVOKED', async () => {
    // 新会话保持 acp:start 未应答（start 在途窗口内 controller-api 不回收 MCP 归属，
    // 请求才能穿过 relay 送抵 agent-api dispatch 层，验证 key 失效 401 而非 relay 404）
    const startPromise = waitForEvent<StartEvent>(devFake!.client, 'acp:start', 30000);
    const sessionRes = await gql(
      CREATE_SESSION,
      {
        input: {
          controllerId: devFake!.controllerId,
          acpServerType: 'opencode',
          workspaceId: projectWorkspaceId,
          mcpServerIds: [],
          customMcpServerIds: [badMcpId],
        },
      },
      developer.token,
      ws1,
    );
    expect(sessionRes.errors, JSON.stringify(sessionRes.errors)).toBeUndefined();
    const terminalSessionId = sessionRes.data.createSession.session.id as string;
    const start = await startPromise;
    const terminalToken = start.mcpEndpoint!.token;
    expect(start.mcpEndpoint!.serverNames).toEqual([badMcpName]);

    // 关闭会话：endpoint 立即 revoke（Redis mcp:endpoint:<sid>=revoked）
    const closed = await gql(CLOSE_SESSION, { id: terminalSessionId }, developer.token, ws1);
    expect(closed.errors, JSON.stringify(closed.errors)).toBeUndefined();
    expect(closed.data.closeSession).toBe(true);

    const revoked = await relayCall(devFake!.client, terminalSessionId, badMcpName, terminalToken, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/list',
    });
    expect(revoked.status).toBe(401);
    expect(revoked.body.error).toBeDefined();
    expect(revoked.body.error.code).toBe('ENDPOINT_REVOKED');
    expect(revoked.body.error.message).toBe('Invalid token');

    // 诊断优先级 401 > 作用域 > 410 > 502：终态后重复请求仍 401（不落到 410/502 分支）
    const again = await relayCall(devFake!.client, terminalSessionId, badMcpName, terminalToken, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/list',
    });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('ENDPOINT_REVOKED');
  }, 90_000);
});
