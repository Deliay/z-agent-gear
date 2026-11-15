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

  it('T-AP-API1: prompts/list 返回两段片段（name 集合与 description 非空）', async () => {
    const response = await relayMcpRequest('prompts_list_1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'prompts/list',
    });
    expect(response.status).toBe(200);
    expect(response.body.error).toBeUndefined();
    const prompts = response.body.result.prompts as Array<{ name: string; description?: string }>;
    expect(prompts).toHaveLength(2);
    expect(new Set(prompts.map((item) => item.name))).toEqual(
      new Set(['workflow-schema', 'workflow-project-persistence']),
    );
    for (const item of prompts) expect((item.description ?? '').trim().length).toBeGreaterThan(0);
  });

  it('T-AP-API2: prompts/get 返回 messages 形态文本（首节点 / 模板目录口径）', async () => {
    const schema = await relayMcpRequest('prompts_get_schema', {
      jsonrpc: '2.0',
      id: 2,
      method: 'prompts/get',
      params: { name: 'workflow-schema' },
    });
    expect(schema.status).toBe(200);
    expect(schema.body.error).toBeUndefined();
    expect((schema.body.result.description ?? '').trim().length).toBeGreaterThan(0);
    expect(schema.body.result.messages[0].content.type).toBe('text');
    expect(schema.body.result.messages[0].content.text).toContain('首节点');

    const persistence = await relayMcpRequest('prompts_get_persistence', {
      jsonrpc: '2.0',
      id: 3,
      method: 'prompts/get',
      params: { name: 'workflow-project-persistence' },
    });
    expect(persistence.status).toBe(200);
    expect(persistence.body.error).toBeUndefined();
    expect(persistence.body.result.messages[0].content.text).toContain('.zag/workflow/templates');
  });

  it('T-AP-API3: 未知片段返回 INVALID_PARAMS；同会话 initialize 声明 prompts 能力', async () => {
    const unknown = await relayMcpRequest('prompts_get_unknown', {
      jsonrpc: '2.0',
      id: 4,
      method: 'prompts/get',
      params: { name: 'nope' },
    });
    expect(unknown.status).toBe(200);
    expect(unknown.body.result).toBeUndefined();
    expect(unknown.body.error.code).toBe('INVALID_PARAMS');
    expect(unknown.body.error.message).toContain('nope');
    expect(unknown.body.error.message).toContain('workflow-schema');
    expect(unknown.body.error.message).toContain('workflow-project-persistence');

    const initialized = await relayMcpRequest('prompts_initialize', {
      jsonrpc: '2.0',
      id: 5,
      method: 'initialize',
    });
    expect(initialized.status).toBe(200);
    expect(initialized.body.error).toBeUndefined();
    expect(initialized.body.result.capabilities).toHaveProperty('prompts');
    expect(initialized.body.result.capabilities).toHaveProperty('tools');
  });
});
