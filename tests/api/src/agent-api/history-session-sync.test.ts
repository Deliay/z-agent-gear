import { describe, it, expect, beforeAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';

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

const CREATE_WORKSPACE = `
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) {
      id controllerId path
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

const IMPORT_HISTORY_SESSIONS = `
  mutation ImportHistorySessions($controllerId: ID!, $workspaceId: ID!, $sessionIds: [String!]!) {
    importHistorySessions(controllerId: $controllerId, workspaceId: $workspaceId, sessionIds: $sessionIds) {
      sessionId acpSessionId title success error messageCount
    }
  }
`;

const LIST_HISTORY_SESSIONS_WITH_TYPE = `
  query ListHistorySessions($controllerId: ID!, $workspaceId: ID!, $acpServerType: AcpServerType) {
    listHistorySessions(controllerId: $controllerId, workspaceId: $workspaceId, acpServerType: $acpServerType) {
      sessionId title cwd updatedAt
    }
  }
`;

const IMPORT_HISTORY_SESSIONS_WITH_TYPE = `
  mutation ImportHistorySessions($controllerId: ID!, $workspaceId: ID!, $acpServerType: AcpServerType, $sessionIds: [String!]!) {
    importHistorySessions(controllerId: $controllerId, workspaceId: $workspaceId, acpServerType: $acpServerType, sessionIds: $sessionIds) {
      sessionId acpSessionId title success error messageCount
    }
  }
`;

const SESSIONS_QUERY = `
  query Sessions {
    sessions {
      id externalSessionId title status cwd
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

function waitForEvent<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

let authToken = '';

interface ControllerSetup {
  rawKey: string;
  controllerId: string;
  client: ClientSocket;
}

async function createFreshController(): Promise<ControllerSetup> {
  const keyRes = await gqlRequest(
    CREATE_KEY,
    { input: { name: `hsync-${Date.now()}`, type: 'local' } },
    authToken,
  );
  const keyBody = await keyRes.json();
  const rawKey = keyBody.data.createControllerKey.rawKey;

  const client = createClient();
  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', { key: rawKey, hostname: 'hsync-test-host', version: '2.0.0' });
  const regData = await registered;

  return { rawKey, controllerId: regData.controllerId, client };
}

async function createTestWorkspace(controllerId: string): Promise<string> {
  const res = await gqlRequest(
    CREATE_WORKSPACE,
    { input: { controllerId, path: `/tmp/hsync-test-${Date.now()}` } },
    authToken,
  );
  const body = await res.json();
  return body.data.createWorkspace.id;
}

function autoRespondToSyncEvents(socket: ClientSocket) {
  socket.on('acp:list-sessions', (payload: { requestId: string; cwd: string }) => {
    socket.emit('acp:list-sessions:result', {
      requestId: payload.requestId,
      success: true,
      sessions: [
        { sessionId: 'acp_sync_sess_1', title: 'Sync Session 1', cwd: payload.cwd, updatedAt: new Date().toISOString() },
        { sessionId: 'acp_sync_sess_2', title: null, cwd: payload.cwd, updatedAt: null },
      ],
    });
  });

  socket.on('acp:load-session', (payload: { requestId: string; sessionId: string; cwd: string }) => {
    socket.emit('acp:load-session:result', {
      requestId: payload.requestId,
      success: true,
      sessionId: payload.sessionId,
      title: `History - ${payload.sessionId}`,
      messages: [
        { direction: 'input', type: 'text', content: JSON.stringify({ text: 'Hello from history' }) },
        { direction: 'output', type: 'text', content: JSON.stringify({ text: 'Hi back' }) },
      ],
    });
  });
}

describe('History Session Sync API', () => {
  beforeAll(async () => {
    const uid = `hsync_${Date.now().toString(36)}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token ?? '';
    expect(authToken).toBeTruthy();
  });

  describe('listHistorySessions query', () => {
    it('should reject without auth', async () => {
      const res = await gqlRequest(LIST_HISTORY_SESSIONS, {
        controllerId: '000000000000000000000000',
        workspaceId: '000000000000000000000000',
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject for non-existent controller', async () => {
      const res = await gqlRequest(LIST_HISTORY_SESSIONS, {
        controllerId: '000000000000000000000000',
        workspaceId: '000000000000000000000000',
      }, authToken);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller not found');
    });

    it('should reject for non-existent workspace', async () => {
      const { controllerId, client } = await createFreshController();

      const res = await gqlRequest(LIST_HISTORY_SESSIONS, {
        controllerId,
        workspaceId: '000000000000000000000000',
      }, authToken);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Workspace not found');

      client.disconnect();
    });

    it('should return history sessions via fake controller', async () => {
      const { controllerId, client } = await createFreshController();
      const wsId = await createTestWorkspace(controllerId);

      autoRespondToSyncEvents(client);

      const res = await gqlRequest(LIST_HISTORY_SESSIONS, {
        controllerId,
        workspaceId: wsId,
      }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      const sessions = body.data.listHistorySessions;
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThanOrEqual(1);

      client.disconnect();
    }, 15000);

    it('should return history sessions with acpServerType parameter', async () => {
      const { controllerId, client } = await createFreshController();
      const wsId = await createTestWorkspace(controllerId);

      autoRespondToSyncEvents(client);

      const res = await gqlRequest(LIST_HISTORY_SESSIONS_WITH_TYPE, {
        controllerId,
        workspaceId: wsId,
        acpServerType: 'claude_code',
      }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      const sessions = body.data.listHistorySessions;
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThanOrEqual(1);

      client.disconnect();
    }, 15000);
  });

  describe('importHistorySessions mutation', () => {
    it('should reject without auth', async () => {
      const res = await gqlRequest(IMPORT_HISTORY_SESSIONS, {
        controllerId: '000000000000000000000000',
        workspaceId: '000000000000000000000000',
        sessionIds: ['test'],
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject for non-existent controller', async () => {
      const res = await gqlRequest(IMPORT_HISTORY_SESSIONS, {
        controllerId: '000000000000000000000000',
        workspaceId: '000000000000000000000000',
        sessionIds: ['test'],
      }, authToken);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller not found');
    });

    it('should import a single history session', async () => {
      const { controllerId, client } = await createFreshController();
      const wsId = await createTestWorkspace(controllerId);

      autoRespondToSyncEvents(client);

      const res = await gqlRequest(IMPORT_HISTORY_SESSIONS, {
        controllerId,
        workspaceId: wsId,
        sessionIds: ['acp_import_single'],
      }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      const results = body.data.importHistorySessions;
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].acpSessionId).toBe('acp_import_single');
      expect(results[0].messageCount).toBe(2);
      expect(results[0].sessionId).toBeDefined();
      expect(results[0].title).toBe('History - acp_import_single');

      client.disconnect();
    }, 20000);

    it('should import multiple history sessions', async () => {
      const { controllerId, client } = await createFreshController();
      const wsId = await createTestWorkspace(controllerId);

      autoRespondToSyncEvents(client);

      const res = await gqlRequest(IMPORT_HISTORY_SESSIONS, {
        controllerId,
        workspaceId: wsId,
        sessionIds: ['acp_import_multi_1', 'acp_import_multi_2'],
      }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      const results = body.data.importHistorySessions;
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[0].acpSessionId).toBe('acp_import_multi_1');
      expect(results[1].success).toBe(true);
      expect(results[1].acpSessionId).toBe('acp_import_multi_2');

      // Verify imported sessions exist in the system
      const sessRes = await gqlRequest(SESSIONS_QUERY, undefined, authToken);
      const sessBody = await sessRes.json();
      const importedSessions = sessBody.data.sessions.filter(
        (s: { externalSessionId: string | null }) =>
          s.externalSessionId === 'acp_import_multi_1' || s.externalSessionId === 'acp_import_multi_2',
      );
      expect(importedSessions).toHaveLength(2);
      expect(importedSessions.every((s: { status: string }) => s.status === 'ended')).toBe(true);
      expect(importedSessions.every((s: { cwd: string }) => s.cwd)).toBeTruthy();

      client.disconnect();
    }, 30000);

    it('should filter already-imported sessions when listing', async () => {
      const { controllerId, client } = await createFreshController();
      const wsId = await createTestWorkspace(controllerId);

      autoRespondToSyncEvents(client);

      // Import acp_sync_sess_1 first — the auto-responder for list returns this ID
      const importRes = await gqlRequest(IMPORT_HISTORY_SESSIONS, {
        controllerId,
        workspaceId: wsId,
        sessionIds: ['acp_sync_sess_1'],
      }, authToken);
      const importBody = await importRes.json();
      expect(importBody.data.importHistorySessions[0].success).toBe(true);

      // Now list should return acp_sync_sess_2 but NOT acp_sync_sess_1
      const listRes = await gqlRequest(LIST_HISTORY_SESSIONS, {
        controllerId,
        workspaceId: wsId,
      }, authToken);
      const listBody = await listRes.json();
      expect(listBody.errors).toBeUndefined();
      const listedIds = listBody.data.listHistorySessions.map((s: { sessionId: string }) => s.sessionId);
      expect(listedIds).not.toContain('acp_sync_sess_1');
      expect(listedIds).toContain('acp_sync_sess_2');

      client.disconnect();
    }, 30000);

    it('should import with acpServerType parameter', async () => {
      const { controllerId, client } = await createFreshController();
      const wsId = await createTestWorkspace(controllerId);

      autoRespondToSyncEvents(client);

      const res = await gqlRequest(IMPORT_HISTORY_SESSIONS_WITH_TYPE, {
        controllerId,
        workspaceId: wsId,
        acpServerType: 'gemini_cli',
        sessionIds: ['acp_import_with_type'],
      }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      const results = body.data.importHistorySessions;
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].acpSessionId).toBe('acp_import_with_type');

      client.disconnect();
    }, 20000);
  });
});
