import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import { createFrontUser } from '../support/front-users.js';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const body: Record<string, unknown> = { query };
  if (variables) {
    body.variables = variables;
  }
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const GET_MCP_SERVERS = `
  query GetMcpServers {
    mcpServers {
      id
      name
      transport
      source
      enabled
      command
      url
      hostname
      status
      tools {
        name
        description
      }
      toolsSyncedAt
      lastHeartbeatAt
      createdAt
      updatedAt
    }
  }
`;

const GET_MCP_SERVER = `
  query GetMcpServer($id: ID!) {
    mcpServer(id: $id) {
      id
      name
      transport
      source
      enabled
      command
      url
      hostname
      status
      tools {
        name
        description
      }
      toolsSyncedAt
      lastHeartbeatAt
      createdAt
      updatedAt
    }
  }
`;

const SET_MCP_SERVER_ENABLED = `
  mutation SetMcpServerEnabled($id: ID!, $enabled: Boolean!) {
    setMcpServerEnabled(id: $id, enabled: $enabled) {
      id
      name
      enabled
      status
    }
  }
`;

let authToken: string;
let userId: string;

beforeAll(async () => {
  const frontUser = await createFrontUser();
  authToken = frontUser.token;
  userId = frontUser.userId;
});

describe('MCP Server API (agent-api)', () => {
  describe('mcpServers query', () => {
    it('should require authentication', async () => {
      const res = await gqlRequest(GET_MCP_SERVERS);
      const data = await res.json() as any;
      expect(data.errors?.[0]?.message).toContain('Not authenticated');
    });

    it('should include the platform admin-tools server by default for authenticated user', async () => {
      const res = await gqlRequest(GET_MCP_SERVERS, undefined, authToken);
      const data = await res.json() as any;
      expect(data.errors).toBeUndefined();
      // 平台内置「工作流管理工具集」默认启用、可装配到任意会话（读路径幂等注册）
      const admin = (data.data?.mcpServers as any[])?.find((s) => s.name === 'agent-workflow-admin-tools');
      expect(admin, 'mcpServers 应默认包含平台内置 agent-workflow-admin-tools').toBeDefined();
      expect(admin.enabled).toBe(true);
      expect(admin.source).toBe('platform');
      expect(admin.transport).toBe('platform');
    });
  });

  describe('mcpServer query', () => {
    it('should require authentication', async () => {
      const res = await gqlRequest(GET_MCP_SERVER, { id: 'nonexistent' });
      const data = await res.json() as any;
      expect(data.errors?.[0]?.message).toContain('Not authenticated');
    });

    it('should return null for non-existent server', async () => {
      const res = await gqlRequest(GET_MCP_SERVER, { id: '000000000000000000000000' }, authToken);
      const data = await res.json() as any;
      expect(data.data?.mcpServer).toBeNull();
    });
  });

  describe('setMcpServerEnabled mutation', () => {
    it('should require authentication', async () => {
      const res = await gqlRequest(SET_MCP_SERVER_ENABLED, { id: '000000000000000000000000', enabled: false });
      const data = await res.json() as any;
      expect(data.errors?.[0]?.message).toContain('Not authenticated');
    });

    it('should throw Server not found for non-existent server', async () => {
      const res = await gqlRequest(
        SET_MCP_SERVER_ENABLED,
        { id: '000000000000000000000000', enabled: false },
        authToken,
      );
      const data = await res.json() as any;
      expect(data.errors?.[0]?.message).toContain('Server not found');
    });
  });
});

// ---- 工作流 MCP 提示词片段（#523）：T-AP-API1~3 ----
// 平台 MCP 统一经控制器 relay：fake controller 在 Socket.IO 主连接发 `mcp:request`，
// controller-api → Redis → agent-api mcp-dispatch 按 requestId 匹配 `mcp:response`。

const CREATE_KEY = `
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) {
      key { id name }
      rawKey
    }
  }
`;

const CREATE_WORKSPACE = `
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) {
      id controllerId path
    }
  }
`;

const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      session { id controllerId acpServerType status }
    }
  }
`;

const DELETE_SESSION = `
  mutation DeleteSession($id: ID!) {
    deleteSession(id: $id)
  }
`;

function createClient(): ClientSocket {
  return SocketIOClient(CONTROLLER_API_URL, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
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

describe('MCP prompts API（工作流提示词片段）', () => {
  let promptToken = '';
  let client: ClientSocket;
  let controllerId = '';
  let workspaceId = '';
  let sessionId = '';
  let mcpToken = '';

  /** 经 fake controller relay 发 JSON-RPC 请求（按 requestId 匹配 mcp:response） */
  function relayMcpRequest(requestId: string, body: Record<string, unknown>) {
    return new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP relay timeout: ${requestId}`)), 15000);
      const onResponse = (data: { requestId: string; status: number; body: Record<string, any> }) => {
        if (data.requestId !== requestId) return;
        clearTimeout(timer);
        client.off('mcp:response', onResponse);
        resolve(data);
      };
      client.on('mcp:response', onResponse);
      client.emit('mcp:request', {
        requestId,
        sessionId,
        serverName: 'agent-workflow-admin-tools',
        token: mcpToken,
        body,
      });
    });
  }

  beforeAll(async () => {
    promptToken = (await createFrontUser()).token;

    const keyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `prompts-key-${Date.now()}`, type: 'local' } },
      promptToken,
    );
    const keyBody = await keyRes.json() as any;
    expect(keyBody.errors).toBeUndefined();

    client = createClient();
    client.on('acp:stop', (data: { sessionId: string }) => {
      client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_delete' });
    });
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', {
      key: keyBody.data.createControllerKey.rawKey,
      hostname: `prompts-host-${Date.now()}`,
      version: '2.18.0',
    });
    controllerId = (await registered).controllerId;

    const workspaceRes = await gqlRequest(
      CREATE_WORKSPACE,
      { input: { controllerId, path: `/tmp/prompts-test-${Date.now()}` } },
      promptToken,
    );
    const workspaceBody = await workspaceRes.json() as any;
    expect(workspaceBody.errors).toBeUndefined();
    workspaceId = workspaceBody.data.createWorkspace.id;

    const serversRes = await gqlRequest(GET_MCP_SERVERS, undefined, promptToken);
    const serversBody = await serversRes.json() as any;
    const admin = (serversBody.data.mcpServers as any[]).find(
      (server) => server.name === 'agent-workflow-admin-tools',
    );
    expect(admin).toBeDefined();

    const startEvent = waitForEvent<Record<string, any>>(client, 'acp:start');
    const sessionRes = await gqlRequest(
      CREATE_SESSION,
      {
        input: {
          controllerId,
          acpServerType: 'opencode',
          workspaceId,
          mcpServerIds: [admin.id],
        },
      },
      promptToken,
    );
    const sessionBody = await sessionRes.json() as any;
    expect(sessionBody.errors).toBeUndefined();
    sessionId = sessionBody.data.createSession.session.id;
    const start = await startEvent;
    expect(start.mcpEndpoint?.serverNames).toContain('agent-workflow-admin-tools');
    mcpToken = start.mcpEndpoint.token;
    client.emit('acp:start:result', {
      requestId: start.requestId,
      sessionId,
      success: true,
      externalSessionId: `ext_prompts_${Date.now()}`,
    });
    // 等会话 endpoint 状态收敛为 active（mcp-dispatch 以 active 判定）
    await new Promise((resolve) => setTimeout(resolve, 500));
  }, 60_000);

  afterAll(async () => {
    if (sessionId) await gqlRequest(DELETE_SESSION, { id: sessionId }, promptToken);
    client?.disconnect();
  }, 60_000);

  it('T-AP-API1: resources/list 返回两段片段（URI/name/description/mimeType）', async () => {
    const response = await relayMcpRequest('resources_list_1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/list',
    });
    expect(response.status).toBe(200);
    expect(response.body.error).toBeUndefined();
    const resources = response.body.result.resources as Array<{
      uri: string;
      name: string;
      description?: string;
      mimeType?: string;
    }>;
    expect(resources).toHaveLength(2);
    expect(new Set(resources.map((item) => item.name))).toEqual(
      new Set(['workflow-schema', 'workflow-project-persistence']),
    );
    for (const item of resources) {
      expect(item.uri).toBe(
        `zag://agent-workflow-admin-tools/prompt/${item.name}`,
      );
      expect((item.description ?? '').trim().length).toBeGreaterThan(0);
      expect(item.mimeType).toBe('text/markdown');
    }
  });

  it('T-AP-API2: resources/read 返回 text/markdown 正文（首节点 / 模板目录口径）', async () => {
    const schema = await relayMcpRequest('resources_read_schema', {
      jsonrpc: '2.0',
      id: 2,
      method: 'resources/read',
      params: { uri: 'zag://agent-workflow-admin-tools/prompt/workflow-schema' },
    });
    expect(schema.status).toBe(200);
    expect(schema.body.error).toBeUndefined();
    expect(schema.body.result.contents[0].mimeType).toBe('text/markdown');
    expect(schema.body.result.contents[0].text).toContain('首节点');

    const persistence = await relayMcpRequest('resources_read_persistence', {
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/read',
      params: { uri: 'zag://agent-workflow-admin-tools/prompt/workflow-project-persistence' },
    });
    expect(persistence.status).toBe(200);
    expect(persistence.body.error).toBeUndefined();
    expect(persistence.body.result.contents[0].text).toContain('.zag/workflow/templates');
  });

  it('T-AP-API3: 未知 URI 返回 INVALID_PARAMS；同会话 initialize 声明 resources 能力且 prompts 已移除', async () => {
    const unknown = await relayMcpRequest('resources_read_unknown', {
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: { uri: 'zag://agent-workflow-admin-tools/prompt/nope' },
    });
    expect(unknown.status).toBe(200);
    expect(unknown.body.result).toBeUndefined();
    expect(unknown.body.error.code).toBe('INVALID_PARAMS');
    expect(unknown.body.error.message).toContain('nope');
    expect(unknown.body.error.message).toContain('workflow-schema');
    expect(unknown.body.error.message).toContain('workflow-project-persistence');

    const initialized = await relayMcpRequest('resources_initialize', {
      jsonrpc: '2.0',
      id: 5,
      method: 'initialize',
    });
    expect(initialized.status).toBe(200);
    expect(initialized.body.error).toBeUndefined();
    expect(initialized.body.result.capabilities).toHaveProperty('resources');
    expect(initialized.body.result.capabilities).toHaveProperty('tools');
    expect(initialized.body.result.capabilities).not.toHaveProperty('prompts');

    const promptsList = await relayMcpRequest('prompts_list_removed', {
      jsonrpc: '2.0',
      id: 6,
      method: 'prompts/list',
    });
    expect(promptsList.status).toBe(200);
    expect(promptsList.body.error.code).toBe('METHOD_NOT_FOUND');
  });
});

// ---- 网关 MCP 工具（#565）：T-GMCP-API1~6 ----
// 平台 MCP 统一经控制器 relay 验证：创建端点后返回 endpoint/basePath，且与 GraphQL `Gateway.endpoint` 逐字一致。

const GATEWAYS_QUERY = `
  query Gateways($controllerId: ID!) {
    gateways(controllerId: $controllerId) {
      gateways { name port status endpoint }
      total
      limit
    }
  }
`;

describe('网关 MCP 工具 API（agent-gateway-tools）', () => {
  let gwToken = '';
  let client: ClientSocket;
  let controllerId = '';
  let workspaceId = '';
  let sessionId = '';
  let mcpToken = '';
  let serverNames: string[] = [];

  function relay(requestId: string, body: Record<string, unknown>) {
    return new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gateway MCP relay timeout: ${requestId}`)), 15000);
      const onResponse = (data: { requestId: string; status: number; body: Record<string, any> }) => {
        if (data.requestId !== requestId) return;
        clearTimeout(timer);
        client.off('mcp:response', onResponse);
        resolve(data);
      };
      client.on('mcp:response', onResponse);
      client.emit('mcp:request', {
        requestId,
        sessionId,
        serverName: 'agent-gateway-tools',
        token: mcpToken,
        body,
      });
    });
  }

  function parseTool(result: { body: Record<string, any> }) {
    const text = result.body.result?.content?.[0]?.text;
    return { parsed: JSON.parse(text), isError: Boolean(result.body.result?.isError) };
  }

  beforeAll(async () => {
    gwToken = (await createFrontUser()).token;

    const keyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `gateway-mcp-key-${Date.now()}`, type: 'local' } },
      gwToken,
    );
    const keyBody = await keyRes.json() as any;
    expect(keyBody.errors).toBeUndefined();

    client = createClient();
    client.on('acp:stop', (data: { sessionId: string }) => {
      client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_delete' });
    });
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', {
      key: keyBody.data.createControllerKey.rawKey,
      hostname: `gateway-mcp-host-${Date.now()}`,
      version: '2.18.0',
    });
    controllerId = (await registered).controllerId;

    const workspaceRes = await gqlRequest(
      CREATE_WORKSPACE,
      { input: { controllerId, path: `/tmp/gateway-mcp-test-${Date.now()}` } },
      gwToken,
    );
    const workspaceBody = await workspaceRes.json() as any;
    expect(workspaceBody.errors).toBeUndefined();
    workspaceId = workspaceBody.data.createWorkspace.id;

    const startEvent = waitForEvent<Record<string, any>>(client, 'acp:start');
    const sessionRes = await gqlRequest(
      CREATE_SESSION,
      {
        input: {
          controllerId,
          acpServerType: 'opencode',
          workspaceId,
          // 显式空数组：平台服务仍恒装配（包含 agent-gateway-tools）
          mcpServerIds: [],
        },
      },
      gwToken,
    );
    const sessionBody = await sessionRes.json() as any;
    expect(sessionBody.errors).toBeUndefined();
    sessionId = sessionBody.data.createSession.session.id;
    const start = await startEvent;
    serverNames = (start.mcpEndpoint?.serverNames ?? []) as string[];
    mcpToken = start.mcpEndpoint.token;
    client.emit('acp:start:result', {
      requestId: start.requestId,
      sessionId,
      success: true,
      externalSessionId: `ext_gateway_${Date.now()}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }, 60_000);

  afterAll(async () => {
    if (sessionId) await gqlRequest(DELETE_SESSION, { id: sessionId }, gwToken);
    client?.disconnect();
  }, 60_000);

  it('T-GMCP-API1: 会话 mcpEndpoint.serverNames 含 agent-gateway-tools', () => {
    expect(serverNames).toContain('agent-gateway-tools');
  });

  it('T-GMCP-API2: 创建返回 endpoint/basePath，与 GraphQL Gateway.endpoint 逐字一致', async () => {
    const created = await relay('gw_create_1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'gateway_create_endpoint', arguments: { name: 'my-svc', port: 5173 } },
    });
    expect(created.status).toBe(200);
    const { parsed, isError } = parseTool(created);
    expect(isError).toBe(false);
    expect(parsed).toMatchObject({
      name: 'my-svc',
      port: 5173,
      status: 'active',
      basePath: `/api/gateway/${controllerId}/my-svc/`,
    });
    expect(parsed.endpoint).toMatch(new RegExp(`/api/gateway/${controllerId}/my-svc/$`));

    const gql = await gqlRequest(GATEWAYS_QUERY, { controllerId }, gwToken);
    const gqlBody = await gql.json() as any;
    const row = (gqlBody.data.gateways.gateways as any[]).find((item) => item.name === 'my-svc');
    expect(row).toBeDefined();
    expect(row.endpoint).toBe(parsed.endpoint);

    // 匿名访问端点 → 401（登录前提）
    const anonymous = await fetch(parsed.endpoint, { redirect: 'manual' });
    expect(anonymous.status).toBe(401);
  });

  it('T-GMCP-API3: gateway_list / gateway_delete_endpoint 全链路', async () => {
    const listed = await relay('gw_list_1', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'gateway_list', arguments: {} },
    });
    const { parsed: list } = parseTool(listed);
    expect(list.limit).toBe(5);
    const row = (list.gateways as any[]).find((item) => item.name === 'my-svc');
    expect(row).toBeDefined();
    expect(row.basePath).toBe(`/api/gateway/${controllerId}/my-svc/`);

    const deleted = await relay('gw_delete_1', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'gateway_delete_endpoint', arguments: { name: 'my-svc' } },
    });
    expect(parseTool(deleted).parsed).toEqual({ deleted: true });

    const listedAfter = await relay('gw_list_2', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'gateway_list', arguments: {} },
    });
    expect((parseTool(listedAfter).parsed.gateways as any[]).some((item) => item.name === 'my-svc')).toBe(false);
  });

  it('T-GMCP-API4: resources/read 正文可达且含 Vite 示例；未知 URI → INVALID_PARAMS', async () => {
    const list = await relay('gw_res_list', { jsonrpc: '2.0', id: 5, method: 'resources/list' });
    const resources = list.body.result.resources as any[];
    expect(resources.map((item) => item.name)).toEqual(['gateway-exposure-guidance']);
    expect(resources[0].uri).toBe('zag://agent-gateway-tools/prompt/gateway-exposure-guidance');

    const read = await relay('gw_res_read', {
      jsonrpc: '2.0',
      id: 6,
      method: 'resources/read',
      params: { uri: 'zag://agent-gateway-tools/prompt/gateway-exposure-guidance' },
    });
    expect(read.body.result.contents[0].mimeType).toBe('text/markdown');
    expect(read.body.result.contents[0].text).toContain('vite.config.ts');
    expect(read.body.result.contents[0].text).toContain('hmr: false');

    const unknown = await relay('gw_res_unknown', {
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/read',
      params: { uri: 'zag://agent-gateway-tools/prompt/nope' },
    });
    expect(unknown.body.error.code).toBe('INVALID_PARAMS');
    expect(unknown.body.error.message).toContain('gateway-exposure-guidance');
  });

  it('T-GMCP-API5: 错误文案逐字（重名 / 删除未命中 / 非法入参）', async () => {
    await relay('gw_create_dup_a', {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'gateway_create_endpoint', arguments: { name: 'dup-svc', port: 3000 } },
    });
    const dup = await relay('gw_create_dup_b', {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'gateway_create_endpoint', arguments: { name: 'dup-svc', port: 3001 } },
    });
    expect(parseTool(dup).isError).toBe(true);
    expect(parseTool(dup).parsed.message).toBe('Gateway name already exists');

    const miss = await relay('gw_delete_miss', {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'gateway_delete_endpoint', arguments: { name: 'nonexistent' } },
    });
    expect(parseTool(miss).parsed.message).toBe('Gateway not found or not active');

    const invalid = await relay('gw_create_invalid', {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'gateway_create_endpoint', arguments: { name: 'bad name!', port: 0 } },
    });
    expect(parseTool(invalid).isError).toBe(true);
    expect(parseTool(invalid).parsed.code).toBe('INVALID_PARAMS');

    // 清理重名端点
    await relay('gw_delete_dup', {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'gateway_delete_endpoint', arguments: { name: 'dup-svc' } },
    });
  });

  it('T-GMCP-API6: 安全回归——删除他人端点/不存在端点统一未找到；匿名 GraphQL 拒绝', async () => {
    const other = (await createFrontUser()).token;
    const anonymous = await gqlRequest(GATEWAYS_QUERY, { controllerId });
    expect((await anonymous.json() as any).errors[0].message).toBe('Not authenticated');

    // 其他用户调用删除同一 controller 上的端点（经自身会话不可达；此处验证 GraphQL 归属口径零泄露）
    const otherList = await gqlRequest(GATEWAYS_QUERY, { controllerId }, other);
    const otherBody = await otherList.json() as any;
    expect(otherBody.errors).toBeUndefined();
    expect(otherBody.data.gateways.gateways).toEqual([]);
  });
});
