import { describe, it, expect, beforeAll } from 'vitest';
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

const CREATE_KEY = `
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) {
      key { id name }
      rawKey
    }
  }
`;

const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      session { id status }
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

const SESSION_QUERY = `
  query Session($id: ID!) {
    session(id: $id) {
      id status externalSessionId
    }
  }
`;

const SET_SESSION_CONFIG_OPTION = `
  mutation SetSessionConfigOption($sessionId: ID!, $configId: String!, $value: String!) {
    setSessionConfigOption(sessionId: $sessionId, configId: $configId, value: $value)
  }
`;

const DELETE_HISTORY_SESSION = `
  mutation DeleteHistorySession($sessionId: ID!, $syncAgent: Boolean) {
    deleteHistorySession(sessionId: $sessionId, syncAgent: $syncAgent) {
      success
      syncedToAgent
      error
    }
  }
`;

const LIST_HISTORY_SESSIONS = `
  query ListHistorySessions($controllerId: ID!, $workspaceId: ID!) {
    listHistorySessions(controllerId: $controllerId, workspaceId: $workspaceId) {
      sessionId title cwd updatedAt
    }
  }
`;

function createClient(): ClientSocket {
  return SocketIOClient(CONTROLLER_API_URL, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

function waitForEvent<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

let authToken = '';
let userId = '';

async function createFreshController(): Promise<{ rawKey: string; controllerId: string; client: ClientSocket }> {
  const keyRes = await gqlRequest(
    CREATE_KEY,
    { input: { name: `acp-fresh-${Date.now()}`, type: 'local' } },
    authToken,
  );
  const keyBody = await keyRes.json();
  const rawKey = keyBody.data.createControllerKey.rawKey;

  const client = createClient();
  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', { key: rawKey, hostname: 'acp-test-host', version: '2.0.0' });
  const regData = await registered;

  return { rawKey, controllerId: regData.controllerId, client };
}

async function createWorkspace(controllerId: string): Promise<string> {
  const res = await gqlRequest(
    CREATE_WORKSPACE,
    { input: { controllerId, path: `/tmp/test-${Date.now()}` } },
    authToken,
  );
  const body = await res.json();
  return body.data.createWorkspace.id;
}

describe('Controller API ACP WebSocket', () => {
  beforeAll(async () => {
    const frontUser = await createFrontUser();
    authToken = frontUser.token;
    userId = frontUser.userId;
    expect(authToken).toBeTruthy();
  });

  describe('acp:check:result', () => {
    it('should handle acp:check:result from controller', async () => {
      const { client } = await createFreshController();

      // Controller sends acp:check:result (simulating response to server's acp:check)
      client.emit('acp:check:result', {
        requestId: 'test-req-1',
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      });

      await new Promise((r) => setTimeout(r, 200));
      client.disconnect();
    });

    it('should handle acp:check:result with all 5 server types', async () => {
      const { client } = await createFreshController();

      client.emit('acp:check:result', {
        requestId: 'test-req-all-5',
        servers: [
          { type: 'opencode', available: true, version: '1.0.0' },
          { type: 'github_copilot', available: true, version: '2.0.0' },
          { type: 'claude_code', available: true, version: '3.0.0' },
          { type: 'gemini_cli', available: true, version: '4.0.0' },
          { type: 'codex', available: true, version: '5.0.0' },
        ],
      });

      await new Promise((r) => setTimeout(r, 200));
      client.disconnect();
    });
  });

  describe('acp:start via createSession', () => {
    it('should send acp:start to controller when session is created', async () => {
      const { controllerId, client } = await createFreshController();
      const workspaceId = await createWorkspace(controllerId);

      // Listen for acp:start BEFORE creating session
      const startEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
        serverType: string;
        cwd: string;
      }>(client, 'acp:start', 10000);

      // Create session via agent-api → triggers acp:start via Redis
      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      // Controller receives acp:start
      const startData = await startEvent;
      expect(startData.sessionId).toBe(sessionId);
      expect(startData.serverType).toBe('opencode');
      expect(startData.requestId).toBeDefined();

      // Respond with success
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });

      await new Promise((r) => setTimeout(r, 300));

      // Verify session status updated to idling
      const verifyRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.data.session.status).toBe('idling');

      client.disconnect();
    });

    it('should include mcpEndpoint with serverNames in acp:start when session created with MCP servers', async () => {
      const { controllerId, client } = await createFreshController();
      const workspaceId = await createWorkspace(controllerId);

      // Register an MCP proxy server (mcp-proxy) so it can be selected
      const keyRes = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ name: `acp-ws-mcp-key-${Date.now()}` }),
      });
      const keyData = await keyRes.json();
      expect(keyData.rawKey).toBeDefined();

      const serverName = `fluentui-mcp-${Date.now().toString(36)}`;
      const regRes = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: keyData.rawKey,
          hostname: 'acp-ws-test-host',
          command: 'npx -y fluentui-mcp',
          serverName,
        }),
      });
      const regData = await regRes.json();
      expect(regData.success).toBe(true);
      expect(regData.serverId).toBeDefined();

      const startEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
        mcpEndpoint?: { token: string; serverNames: string[] };
      }>(client, 'acp:start', 10000);

      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId, mcpServerIds: [regData.serverId] } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      const startData = await startEvent;
      expect(startData.sessionId).toBe(sessionId);
      // Regression: agent-controller requires serverNames to assemble per-server
      // MCP URLs; a missing field previously crashed the bridge with a raw
      // TypeError and no diagnostic output.
      expect(startData.mcpEndpoint).toBeDefined();
      // MCP 传递重构一期：mcpEndpoint 不再携带 url（回环地址由 controller 本机生成）
      expect(startData.mcpEndpoint!.url).toBeUndefined();
      expect(startData.mcpEndpoint!.token).toBeTruthy();
      expect(startData.mcpEndpoint!.serverNames).toEqual([serverName]);

      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });

      await new Promise((r) => setTimeout(r, 300));
      client.disconnect();
    });

    it('should handle acp:start failure from controller', async () => {
      const { controllerId, client } = await createFreshController();
      const workspaceId = await createWorkspace(controllerId);

      const startEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
      }>(client, 'acp:start', 10000);

      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      const startData = await startEvent;

      // Respond with failure
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: false,
        error: 'OpenCode not installed',
      });

      await new Promise((r) => setTimeout(r, 300));

      // Verify session status updated to ended
      const verifyRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.data.session.status).toBe('ended');

      client.disconnect();
    });

    it('should handle acp:start with github_copilot serverType', async () => {
      const { controllerId, client } = await createFreshController();
      const workspaceId = await createWorkspace(controllerId);

      const startEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
        serverType: string;
        cwd: string;
      }>(client, 'acp:start', 10000);

      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'github_copilot', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      const startData = await startEvent;
      expect(startData.sessionId).toBe(sessionId);
      expect(startData.serverType).toBe('github_copilot');
      expect(startData.requestId).toBeDefined();

      // Respond with success
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_gc_${Date.now()}`,
      });

      await new Promise((r) => setTimeout(r, 300));

      const verifyRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.data.session.status).toBe('idling');

      client.disconnect();
    });

    it('should handle acp:start with claude_code serverType', async () => {
      const { controllerId, client } = await createFreshController();
      const workspaceId = await createWorkspace(controllerId);

      const startEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
        serverType: string;
        cwd: string;
      }>(client, 'acp:start', 10000);

      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'claude_code', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      const startData = await startEvent;
      expect(startData.sessionId).toBe(sessionId);
      expect(startData.serverType).toBe('claude_code');
      expect(startData.requestId).toBeDefined();

      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_cc_${Date.now()}`,
      });

      await new Promise((r) => setTimeout(r, 300));

      const verifyRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.data.session.status).toBe('idling');

      client.disconnect();
    });

    it('should handle acp:start with gemini_cli serverType', async () => {
      const { controllerId, client } = await createFreshController();
      const workspaceId = await createWorkspace(controllerId);

      const startEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
        serverType: string;
        cwd: string;
      }>(client, 'acp:start', 10000);

      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'gemini_cli', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      const startData = await startEvent;
      expect(startData.sessionId).toBe(sessionId);
      expect(startData.serverType).toBe('gemini_cli');
      expect(startData.requestId).toBeDefined();

      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_gc_${Date.now()}`,
      });

      await new Promise((r) => setTimeout(r, 300));

      const verifyRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.data.session.status).toBe('idling');

      client.disconnect();
    });

    it('should handle acp:start with codex serverType', async () => {
      const { controllerId, client } = await createFreshController();
      const workspaceId = await createWorkspace(controllerId);

      const startEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
        serverType: string;
        cwd: string;
      }>(client, 'acp:start', 10000);

      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'codex', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      const startData = await startEvent;
      expect(startData.sessionId).toBe(sessionId);
      expect(startData.serverType).toBe('codex');
      expect(startData.requestId).toBeDefined();

      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_cd_${Date.now()}`,
      });

      await new Promise((r) => setTimeout(r, 300));

      const verifyRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.data.session.status).toBe('idling');

      client.disconnect();
    });
  });

  describe('acp:message from controller', () => {
    it('should handle output message from controller and persist to DB', async () => {
      const { controllerId, client } = await createFreshController();
      const workspaceId = await createWorkspace(controllerId);

      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start', 10000);

      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      const startData = await startEvent;
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
      });

      await new Promise((r) => setTimeout(r, 300));

      // Controller sends output message (ACP SDK format)
      client.emit('acp:message', {
        sessionId,
        message: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello from controller' },
        },
      });

      await new Promise((r) => setTimeout(r, 500));

      // Verify message persisted (check via agent-api GraphQL)
      const msgQuery = `
        query SessionMessages($sessionId: ID!, $before: ID, $limit: Int) {
          sessionMessages(sessionId: $sessionId, before: $before, limit: $limit) {
            id direction type content
          }
        }
      `;
      const msgRes = await gqlRequest(msgQuery, { sessionId, limit: 10 }, authToken);
      const msgBody = await msgRes.json();
      const messages = msgBody.data.sessionMessages;
      expect(messages.length).toBeGreaterThanOrEqual(1);

      const outputMsg = messages.find((m: { direction: string; content: string }) => m.direction === 'output');
      expect(outputMsg).toBeDefined();
      // Content is stored as raw ACP SessionUpdate (already JSON object)
      expect(outputMsg.content.sessionUpdate).toBe('agent_message_chunk');
      expect(outputMsg.content.content.text).toBe('Hello from controller');

      client.disconnect();
    });

    it('should persist messageId from controller message and expose it via query', async () => {
      const { controllerId, client } = await createFreshController();
      const workspaceId = await createWorkspace(controllerId);

      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start', 10000);

      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      const startData = await startEvent;
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
      });

      await new Promise((r) => setTimeout(r, 300));

      // Controller sends output message carrying ACP messageId
      client.emit('acp:message', {
        sessionId,
        message: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello with messageId' },
          messageId: 'msg-e2e-123',
        },
      });

      await new Promise((r) => setTimeout(r, 500));

      // Verify messageId persisted (check via agent-api GraphQL)
      const msgQuery = `
        query SessionMessages($sessionId: ID!, $before: ID, $limit: Int) {
          sessionMessages(sessionId: $sessionId, before: $before, limit: $limit) {
            id direction type content messageId
          }
        }
      `;
      const msgRes = await gqlRequest(msgQuery, { sessionId, limit: 10 }, authToken);
      const msgBody = await msgRes.json();
      const messages = msgBody.data.sessionMessages;
      expect(messages.length).toBeGreaterThanOrEqual(1);

      const outputMsg = messages.find((m: { direction: string; messageId?: string }) => m.direction === 'output');
      expect(outputMsg).toBeDefined();
      expect(outputMsg.messageId).toBe('msg-e2e-123');

      client.disconnect();
    });
  });

  describe('acp:stopped from controller', () => {
    it('should update session status to ended when controller sends acp:stopped', async () => {
      const { controllerId, client } = await createFreshController();
      const workspaceId = await createWorkspace(controllerId);

      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start', 10000);

      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      const startData = await startEvent;
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
      });

      await new Promise((r) => setTimeout(r, 300));

      // Controller sends stopped event
      client.emit('acp:stopped', {
        sessionId,
        reason: 'agent_exit',
      });

      await new Promise((r) => setTimeout(r, 500));

      // Verify session status updated to ended
      const verifyRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.data.session.status).toBe('ended');

      client.disconnect();
    });
  });

  describe('acp:set-config-option', () => {
    it('should forward setSessionConfigOption to controller for idling session', async () => {
      const { controllerId, client } = await createFreshController();
      const workspaceId = await createWorkspace(controllerId);

      const startEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
      }>(client, 'acp:start', 10000);

      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      const startData = await startEvent;
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_cfgopt_${Date.now()}`,
        configOptions: [
          { id: 'autosave', name: 'Autosave', category: 'general', type: 'boolean', currentValue: 'false' },
        ],
      });
      await new Promise((r) => setTimeout(r, 300));

      // Listen for acp:set-config-option before calling the mutation
      const setOptionEvent = waitForEvent<{
        sessionId: string;
        configId: string;
        value: string;
      }>(client, 'acp:set-config-option', 10000);

      const setRes = await gqlRequest(
        SET_SESSION_CONFIG_OPTION,
        { sessionId, configId: 'autosave', value: 'true' },
        authToken,
      );
      const setBody = await setRes.json();
      expect(setBody.errors).toBeUndefined();
      expect(setBody.data.setSessionConfigOption).toBe(true);

      const setData = await setOptionEvent;
      expect(setData.sessionId).toBe(sessionId);
      expect(setData.configId).toBe('autosave');
      expect(setData.value).toBe('true');

      client.disconnect();
    });
  });

  describe('acp:delete-history-session', () => {
    it('should forward deleteHistorySession to controller and report syncedToAgent', async () => {
      const { controllerId, client } = await createFreshController();
      const workspaceId = await createWorkspace(controllerId);

      const startEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
      }>(client, 'acp:start', 10000);

      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      const startData = await startEvent;
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_del_${Date.now()}`,
      });
      await new Promise((r) => setTimeout(r, 300));

      // 存活会话删除前必须先停 ACP 进程：fake controller 像真实 controller 一样 ack acp:stop
      const stopEvent = waitForEvent<{ sessionId: string; ackRequired?: boolean }>(client, 'acp:stop', 10000);
      client.on('acp:stop', (data: { sessionId: string }) => {
        client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_delete' });
      });

      // Listen for acp:delete-history-session
      const deleteEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
        externalSessionId: string;
      }>(client, 'acp:delete-history-session', 10000);

      const deletePromise = gqlRequest(
        DELETE_HISTORY_SESSION,
        { sessionId, syncAgent: true },
        authToken,
      );

      // 先收到 acp:stop（停 ACP 进程），再收到 acp:delete-history-session（同步历史删除）
      const stopData = await stopEvent;
      expect(stopData.sessionId).toBe(sessionId);

      const deleteData = await deleteEvent;
      expect(deleteData.sessionId).toBe(sessionId);
      expect(deleteData.externalSessionId).toBeDefined();

      // Controller responds with success + supported
      client.emit('acp:delete-history-session:result', {
        requestId: deleteData.requestId,
        sessionId: deleteData.sessionId,
        success: true,
        supported: true,
      });

      const deleteBody = await (await deletePromise).json();
      expect(deleteBody.errors).toBeUndefined();
      expect(deleteBody.data.deleteHistorySession.success).toBe(true);
      expect(deleteBody.data.deleteHistorySession.syncedToAgent).toBe(true);

      // Session removed locally
      const verifyRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.data.session).toBeNull();

      client.disconnect();
    });
  });

  describe('acp:list-sessions with cursor', () => {
    it('should return paginated sessions and tolerate nextCursor passthrough', async () => {
      const { controllerId, client } = await createFreshController();
      const workspaceId = await createWorkspace(controllerId);

      // Respond to list-sessions with nextCursor (agent-controller-style payload)
      const listEvent = waitForEvent<{
        requestId: string;
        serverType: string;
        cwd: string;
      }>(client, 'acp:list-sessions', 10000);
      client.on('acp:list-sessions', (payload: {
        requestId: string;
        serverType: string;
        cwd: string;
      }) => {
        client.emit('acp:list-sessions:result', {
          requestId: payload.requestId,
          success: true,
          sessions: [
            { sessionId: 'cursor_sess_1', title: 'Cursor Session 1', cwd: payload.cwd, updatedAt: null },
          ],
          nextCursor: 'cursor-2',
        });
      });

      const listRes = await gqlRequest(
        LIST_HISTORY_SESSIONS,
        { controllerId, workspaceId },
        authToken,
      );
      const listBody = await listRes.json();

      const listData = await listEvent;
      expect(listData.serverType).toBe('opencode');
      expect(listData.cwd).toBeDefined();

      expect(listBody.errors).toBeUndefined();
      const sessions = listBody.data.listHistorySessions;
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions.some((s: { sessionId: string }) => s.sessionId === 'cursor_sess_1')).toBe(true);

      client.disconnect();
    }, 15000);
  });
});
