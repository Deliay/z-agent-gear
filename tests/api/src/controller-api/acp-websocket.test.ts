import { describe, it, expect, beforeAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

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

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) {
      token
      user { id username }
    }
  }
`;

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
  client.emit('register', { key: rawKey, hostname: 'acp-test-host', version: '1.0.0' });
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
    const uid = `acp_${Date.now().toString(36)}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token ?? '';
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

    it('should handle acp:check:result with multiple server types', async () => {
      const { client } = await createFreshController();

      client.emit('acp:check:result', {
        requestId: 'test-req-multi',
        servers: [
          { type: 'opencode', available: true, version: '1.0.0' },
          { type: 'github_copilot', available: true, version: '2.0.0' },
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
        query SessionMessages($sessionId: ID!, $limit: Int, $offset: Int) {
          sessionMessages(sessionId: $sessionId, limit: $limit, offset: $offset) {
            id direction type content
          }
        }
      `;
      const msgRes = await gqlRequest(msgQuery, { sessionId, limit: 10, offset: 0 }, authToken);
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
});
