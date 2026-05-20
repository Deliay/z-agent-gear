import { describe, it, expect, beforeAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';
const SSE_BASE_URL = (process.env.API_URL || 'http://localhost:4000').replace(/\/graphql\/?$/, '');

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

const SESSIONS_QUERY = `
  query Sessions {
    sessions {
      id userId controllerId controllerName acpServerType status
      externalSessionId cwd createdAt updatedAt endedAt
    }
  }
`;

const SESSION_QUERY = `
  query Session($id: ID!) {
    session(id: $id) {
      id userId controllerId controllerName acpServerType status
      externalSessionId cwd createdAt updatedAt endedAt
    }
  }
`;

const SESSION_MESSAGES_QUERY = `
  query SessionMessages($sessionId: ID!, $limit: Int, $offset: Int) {
    sessionMessages(sessionId: $sessionId, limit: $limit, offset: $offset) {
      id sessionId direction type content metadata createdAt
    }
  }
`;

const ACP_CAPABILITIES_QUERY = `
  query AcpCapabilities($controllerId: ID!) {
    acpCapabilities(controllerId: $controllerId) {
      type available version
    }
  }
`;

const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      session {
        id userId controllerId controllerName acpServerType status
        externalSessionId cwd createdAt updatedAt endedAt
      }
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

const CLOSE_SESSION = `
  mutation CloseSession($id: ID!) {
    closeSession(id: $id)
  }
`;

const RESUME_SESSION = `
  mutation ResumeSession($id: ID!) {
    resumeSession(id: $id) {
      success
      status
      error
    }
  }
`;

const DELETE_SESSION = `
  mutation DeleteSession($id: ID!) {
    deleteSession(id: $id)
  }
`;

const SEND_SESSION_MESSAGE = `
  mutation SendSessionMessage($sessionId: ID!, $content: String!, $type: AcpMessageType) {
    sendSessionMessage(sessionId: $sessionId, content: $content, type: $type) {
      id sessionId direction type content metadata createdAt
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
let rawKey = '';
let controllerId = '';

async function signup(): Promise<string> {
  const uid = `sess_${Date.now().toString(36)}`;
  const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
  const body = await res.json();
  return body.data?.signup?.token ?? '';
}

async function createKeyAndRegisterController(token: string): Promise<{ rawKey: string; controllerId: string }> {
  const keyRes = await gqlRequest(
    CREATE_KEY,
    { input: { name: `sess-key-${Date.now()}`, type: 'local' } },
    token,
  );
  const keyBody = await keyRes.json();
  const key = keyBody.data.createControllerKey.rawKey;

  const client = createClient();
  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', { key, hostname: 'sess-test-host', version: '1.0.0' });
  const regData = await registered;
  client.disconnect();

  return { rawKey: key, controllerId: regData.controllerId };
}

async function createWorkspace(ctrlId: string): Promise<string> {
  const res = await gqlRequest(
    CREATE_WORKSPACE,
    { input: { controllerId: ctrlId, path: `/tmp/sess-test-${Date.now()}` } },
    authToken,
  );
  const body = await res.json();
  return body.data.createWorkspace.id;
}

describe('Session GraphQL API', () => {
  beforeAll(async () => {
    authToken = await signup();
    expect(authToken).toBeTruthy();

    const ctrl = await createKeyAndRegisterController(authToken);
    rawKey = ctrl.rawKey;
    controllerId = ctrl.controllerId;
  });

  describe('queries without auth', () => {
    it('should reject sessions query without token', async () => {
      const res = await gqlRequest(SESSIONS_QUERY);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject session query without token', async () => {
      const res = await gqlRequest(SESSION_QUERY, { id: '000000000000000000000000' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject createSession without auth', async () => {
      const wsId = '000000000000000000000000';
      const res = await gqlRequest(CREATE_SESSION, {
        input: { controllerId, acpServerType: 'opencode', workspaceId: wsId },
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
    });
  });

  describe('createSession', () => {
    it('should create a new session', async () => {
      const wsId = await createWorkspace(controllerId);
      const res = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.createSession.session.id).toBeDefined();
      expect(body.data.createSession.session.status).toBe('creating');
      expect(body.data.createSession.session.controllerName).toBe('sess-test-host');
      expect(body.data.createSession.session.cwd).toBeDefined();
    });

    it('should reject createSession with invalid controllerId', async () => {
      const res = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: '000000000000000000000000', acpServerType: 'opencode', workspaceId: '000000000000000000000000' } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller not found');
    });
  });

  describe('sessions query', () => {
    it('should return sessions list', async () => {
      const res = await gqlRequest(SESSIONS_QUERY, undefined, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(Array.isArray(body.data.sessions)).toBe(true);
      expect(body.data.sessions.length).toBeGreaterThan(0);
    });
  });

  describe('session query', () => {
    it('should return session by id', async () => {
      const wsId = await createWorkspace(controllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;

      const res = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.session.id).toBe(sessionId);
    });

    it('should return null for non-existent session', async () => {
      const res = await gqlRequest(
        SESSION_QUERY,
        { id: '000000000000000000000000' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.session).toBeNull();
    });
  });

  describe('sendSessionMessage', () => {
    it('should send a message to session', async () => {
      const wsId = await createWorkspace(controllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;

      const res = await gqlRequest(
        SEND_SESSION_MESSAGE,
        { sessionId, content: 'Hello agent', type: 'text' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.sendSessionMessage.direction).toBe('input');
      expect(body.data.sendSessionMessage.content).toBe('Hello agent');
      expect(body.data.sendSessionMessage.type).toBe('text');
    });

    it('should reject sending to non-existent session', async () => {
      const res = await gqlRequest(
        SEND_SESSION_MESSAGE,
        { sessionId: '000000000000000000000000', content: 'test', type: 'text' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
    });
  });

  describe('sessionMessages query', () => {
    it('should return messages for a session', async () => {
      const wsId = await createWorkspace(controllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;

      await gqlRequest(
        SEND_SESSION_MESSAGE,
        { sessionId, content: 'test message', type: 'text' },
        authToken,
      );

      const res = await gqlRequest(
        SESSION_MESSAGES_QUERY,
        { sessionId, limit: 10, offset: 0 },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(Array.isArray(body.data.sessionMessages)).toBe(true);
      expect(body.data.sessionMessages.length).toBeGreaterThan(0);
      expect(body.data.sessionMessages[0].content).toBe('test message');
    });

    it('should reject query for non-existent session', async () => {
      const res = await gqlRequest(
        SESSION_MESSAGES_QUERY,
        { sessionId: '000000000000000000000000', limit: 10, offset: 0 },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
    });
  });

  describe('closeSession', () => {
    it('should close a session', async () => {
      const wsId = await createWorkspace(controllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;

      const res = await gqlRequest(CLOSE_SESSION, { id: sessionId }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.closeSession).toBe(true);

      const sessionRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const sessionBody = await sessionRes.json();
      expect(sessionBody.data.session.status).toBe('ended');
    });
  });

  describe('deleteSession', () => {
    it('should delete a session', async () => {
      const wsId = await createWorkspace(controllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;

      const res = await gqlRequest(DELETE_SESSION, { id: sessionId }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.deleteSession).toBe(true);

      const sessionRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const sessionBody = await sessionRes.json();
      expect(sessionBody.data.session).toBeNull();
    });
  });

  describe('resumeSession', () => {
    it('should reject resumeSession without auth', async () => {
      const res = await gqlRequest(RESUME_SESSION, { id: '000000000000000000000000' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should return error for non-existent session', async () => {
      const res = await gqlRequest(
        RESUME_SESSION,
        { id: '000000000000000000000000' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.resumeSession.success).toBe(false);
      expect(body.data.resumeSession.status).toBe('ended');
      expect(body.data.resumeSession.error).toBe('Session not found');
    });

    it('should return error when session is not ended', async () => {
      const wsId = await createWorkspace(controllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;

      // Session is in 'creating' state, not ended
      const res = await gqlRequest(RESUME_SESSION, { id: sessionId }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.resumeSession.success).toBe(false);
      expect(body.data.resumeSession.status).toBe('creating');
      expect(body.data.resumeSession.error).toBe('Session is not ended');
    });

    it('should return success and status connecting for ended session', async () => {
      const wsId = await createWorkspace(controllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;

      // Close to get ended status
      await gqlRequest(CLOSE_SESSION, { id: sessionId }, authToken);

      const res = await gqlRequest(RESUME_SESSION, { id: sessionId }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.resumeSession.success).toBe(true);
      expect(body.data.resumeSession.status).toBe('connecting');
    });
  });

  describe('acpCapabilities query', () => {
    it('should return capabilities for controller', async () => {
      const res = await gqlRequest(
        ACP_CAPABILITIES_QUERY,
        { controllerId },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(Array.isArray(body.data.acpCapabilities)).toBe(true);
    });

    it('should reject query for non-existent controller', async () => {
      const res = await gqlRequest(
        ACP_CAPABILITIES_QUERY,
        { controllerId: '000000000000000000000000' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
    });
  });
});

describe('Session SSE API', () => {
  beforeAll(async () => {
    if (!authToken) {
      authToken = await signup();
      const ctrl = await createKeyAndRegisterController(authToken);
      rawKey = ctrl.rawKey;
      controllerId = ctrl.controllerId;
    }
  });

  it('should return 401 for unauthenticated SSE request', async () => {
    const res = await fetch(`${SSE_BASE_URL}/api/session/000000000000000000000000/stream`);
    expect(res.status).toBe(401);
  });

  it('should return 404 for non-existent session', async () => {
    const res = await fetch(`${SSE_BASE_URL}/api/session/000000000000000000000000/stream`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(404);
  });

  it('should establish SSE connection for valid session', async () => {
    const wsId = await createWorkspace(controllerId);
    const createRes = await gqlRequest(
      CREATE_SESSION,
      { input: { controllerId, acpServerType: 'opencode', workspaceId: wsId } },
      authToken,
    );
    const createBody = await createRes.json();
    const sessionId = createBody.data.createSession.session.id;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`${SSE_BASE_URL}/api/session/${sessionId}/stream`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain('"type":"history"');

    reader.cancel();
    controller.abort();
  });
});

describe('Session WebSocket ACP Events', () => {
  beforeAll(async () => {
    if (!authToken) {
      authToken = await signup();
      const ctrl = await createKeyAndRegisterController(authToken);
      rawKey = ctrl.rawKey;
      controllerId = ctrl.controllerId;
    }
  });

  it('should handle acp:check result from controller', async () => {
    const client = createClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: rawKey, hostname: 'sess-test-host', version: '1.0.0' });
    await registered;

    // Controller sends acp:check:result (simulating response to server's acp:check)
    client.emit('acp:check:result', {
      requestId: 'test-req-1',
      servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
    });

    await new Promise((r) => setTimeout(r, 200));
    client.disconnect();
  });

  it('should handle acp:start and acp:stop flow', async () => {
    const client = createClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: rawKey, hostname: 'sess-test-host', version: '1.0.0' });
    await registered;

    // Listen for acp:start BEFORE creating session
    const startEvent = waitForEvent<{ requestId: string; sessionId: string; serverType: string; cwd: string }>(client, 'acp:start');

    // Create session → triggers acp:start via Redis
    const wsId = await createWorkspace(controllerId);
    const createRes = await gqlRequest(
      CREATE_SESSION,
      { input: { controllerId, acpServerType: 'opencode', workspaceId: wsId } },
      authToken,
    );
    const createBody = await createRes.json();
    const sessionId = createBody.data.createSession.session.id;

    const startData = await startEvent;
    expect(startData.sessionId).toBe(sessionId);
    expect(startData.serverType).toBe('opencode');

    // Simulate controller responding with success
    client.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId,
      success: true,
    });

    await new Promise((r) => setTimeout(r, 300));

    client.disconnect();
  });

  describe('End-to-end: createSession → acp:start → controller respond → verify status', () => {
    it('should update session status to running after controller responds', async () => {
      // 1. Register a fresh controller
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `e2e-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const freshRawKey = keyBody.data.createControllerKey.rawKey;

      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: freshRawKey, hostname: 'e2e-host', version: '1.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;

      // 2. Listen for acp:start BEFORE creating session
      const startEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
        serverType: string;
        cwd: string;
      }>(client, 'acp:start', 10000);

      // 3. Create session via GraphQL → triggers acp:start via Redis
      const wsId = await createWorkspace(freshControllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: freshControllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;
      expect(createBody.data.createSession.session.status).toBe('creating');

      // 4. Fake controller receives acp:start and responds
      const startData = await startEvent;
      expect(startData.sessionId).toBe(sessionId);
      expect(startData.serverType).toBe('opencode');

      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });

      // 5. Wait for controller-api to process and update MongoDB
      await new Promise((r) => setTimeout(r, 500));

      // 6. Verify session status changed to running via GraphQL query
      const sessionRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const sessionBody = await sessionRes.json();
      expect(sessionBody.errors).toBeUndefined();
      expect(sessionBody.data.session.status).toBe('running');
      expect(sessionBody.data.session.externalSessionId).toBeDefined();

      client.disconnect();
    });

    it('should update session status to ended when controller reports failure', async () => {
      // Register a fresh controller
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `e2e-fail-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const freshRawKey = keyBody.data.createControllerKey.rawKey;

      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: freshRawKey, hostname: 'e2e-fail-host', version: '1.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;

      const startEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
      }>(client, 'acp:start', 10000);

      // Create session
      const wsId2 = await createWorkspace(freshControllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: freshControllerId, acpServerType: 'opencode', workspaceId: wsId2 } },
        authToken,
      );
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;

      // Controller responds with failure
      const startData = await startEvent;
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: false,
        error: 'OpenCode not installed',
      });

      await new Promise((r) => setTimeout(r, 500));

      // Verify session status changed to ended
      const sessionRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const sessionBody = await sessionRes.json();
      expect(sessionBody.data.session.status).toBe('ended');

      client.disconnect();
    });

    it('should handle acp:resume flow: create → acp:start → close → resume → acp:resume → verify idling', async () => {
      // 1. Register a fresh controller
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `resume-e2e-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const freshRawKey = keyBody.data.createControllerKey.rawKey;

      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: freshRawKey, hostname: 'resume-e2e-host', version: '1.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;

      // 2. Create session and start ACP
      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start', 10000);
      const wsId = await createWorkspace(freshControllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: freshControllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const sessionId = createRes.status === 200
        ? (await createRes.json()).data.createSession.session.id
        : '';

      const startData = await startEvent;
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_resume_${Date.now()}`,
      });
      await new Promise((r) => setTimeout(r, 300));

      // 3. Close the session
      await gqlRequest(CLOSE_SESSION, { id: sessionId }, authToken);

      // Verify ended
      let sessionRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      let sessionBody = await sessionRes.json();
      expect(sessionBody.data.session.status).toBe('ended');

      // 4. Listen for acp:resume
      const resumeEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
        externalSessionId: string;
      }>(client, 'acp:resume', 10000);

      // 5. Call resumeSession mutation
      const resumeRes = await gqlRequest(RESUME_SESSION, { id: sessionId }, authToken);
      const resumeBody = await resumeRes.json();
      expect(resumeBody.errors).toBeUndefined();
      expect(resumeBody.data.resumeSession.success).toBe(true);
      expect(resumeBody.data.resumeSession.status).toBe('connecting');

      // 6. Fake controller receives acp:resume
      const resumeData = await resumeEvent;
      expect(resumeData.sessionId).toBe(sessionId);

      client.emit('acp:resume:result', {
        requestId: resumeData.requestId,
        sessionId,
        success: true,
      });

      // 7. Wait for controller-api to process and verify idling
      await new Promise((r) => setTimeout(r, 500));

      sessionRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      sessionBody = await sessionRes.json();
      expect(sessionBody.data.session.status).toBe('idling');

      client.disconnect();
    });

    it('should handle acp:resume failure: resume → controller reports failure → verify ended with error', async () => {
      // Register fresh controller
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `resume-fail-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const freshRawKey = keyBody.data.createControllerKey.rawKey;

      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: freshRawKey, hostname: 'resume-fail-host', version: '1.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;

      // Create session + acp:start
      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start', 10000);
      const wsId = await createWorkspace(freshControllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: freshControllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const sessionId = createRes.status === 200
        ? (await createRes.json()).data.createSession.session.id
        : '';

      const startData = await startEvent;
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_resume_fail_${Date.now()}`,
      });
      await new Promise((r) => setTimeout(r, 300));

      // Close session
      await gqlRequest(CLOSE_SESSION, { id: sessionId }, authToken);

      // Resume
      const resumeEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:resume', 10000);
      await gqlRequest(RESUME_SESSION, { id: sessionId }, authToken);

      const resumeData = await resumeEvent;
      client.emit('acp:resume:result', {
        requestId: resumeData.requestId,
        sessionId,
        success: false,
        error: 'ACP_SESSION_EXPIRED',
      });

      // Verify ended
      await new Promise((r) => setTimeout(r, 500));
      const sessionRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const sessionBody = await sessionRes.json();
      expect(sessionBody.data.session.status).toBe('ended');

      client.disconnect();
    });

    it('should forward input message to controller and persist output', async () => {
      // Register controller
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `e2e-msg-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const freshRawKey = keyBody.data.createControllerKey.rawKey;

      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: freshRawKey, hostname: 'e2e-msg-host', version: '1.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;

      const startEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
      }>(client, 'acp:start', 10000);

      // Create and start session
      const wsId3 = await createWorkspace(freshControllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: freshControllerId, acpServerType: 'opencode', workspaceId: wsId3 } },
        authToken,
      );
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;

      const startData = await startEvent;
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
      });

      await new Promise((r) => setTimeout(r, 300));

      // Listen for acp:message from controller-api (forwarded via Redis session:message)
      const messageEvent = waitForEvent<{
        sessionId: string;
        message: { type: string; content: string };
      }>(client, 'acp:message', 5000);

      // Send message via GraphQL → controller-api forwards to controller
      const msgRes = await gqlRequest(
        SEND_SESSION_MESSAGE,
        { sessionId, content: 'Hello agent', type: 'text' },
        authToken,
      );
      const msgBody = await msgRes.json();
      expect(msgBody.data.sendSessionMessage.direction).toBe('input');
      // agent-api stores raw content; ACP wrapping happens in controller-api
      expect(msgBody.data.sendSessionMessage.content).toBe('Hello agent');

      // Fake controller receives the message
      const msgData = await messageEvent;
      expect(msgData.sessionId).toBe(sessionId);
      expect(msgData.message.content).toBe('Hello agent');

      // Simulate controller sending output back (ACP SDK format)
      client.emit('acp:message', {
        sessionId,
        message: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello human' },
        },
      });

      await new Promise((r) => setTimeout(r, 500));

      // Verify output message persisted
      const messagesRes = await gqlRequest(
        SESSION_MESSAGES_QUERY,
        { sessionId, limit: 10, offset: 0 },
        authToken,
      );
      const messagesBody = await messagesRes.json();
      const messages = messagesBody.data.sessionMessages;
      expect(messages.length).toBeGreaterThanOrEqual(2);

      const inputMsg = messages.find((m: { direction: string; content: string }) => m.direction === 'input');
      const outputMsg = messages.find((m: { direction: string; content: string }) => m.direction === 'output');
      expect(inputMsg).toBeDefined();
      expect(outputMsg).toBeDefined();
      // Content is stored as raw ACP SessionUpdate JSON
      const parsedOutput = JSON.parse(outputMsg.content);
      expect(parsedOutput.sessionUpdate).toBe('agent_message_chunk');
      expect(parsedOutput.content.text).toBe('Hello human');

      client.disconnect();
    });
  });
});
