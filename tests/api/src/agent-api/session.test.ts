import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  query SessionMessages($sessionId: ID!, $before: ID, $limit: Int) {
    sessionMessages(sessionId: $sessionId, before: $before, limit: $limit) {
      id sessionId direction type content metadata createdAt
    }
  }
`;

const ACP_CAPABILITIES_QUERY = `
  query AcpCapabilities($controllerId: ID!) {
    acpCapabilities(controllerId: $controllerId) {
      type available version checkedAt
    }
  }
`;

const REFRESH_ACP_CAPABILITIES_MUTATION = `
  mutation RefreshAcpCapabilities($controllerId: ID!) {
    refreshAcpCapabilities(controllerId: $controllerId) {
      type available version checkedAt
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

const CLEAR_WORKSPACES = `
  mutation ClearWorkspaces($controllerId: ID!) {
    clearWorkspaces(controllerId: $controllerId)
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

const SESSION_WITH_MODES_QUERY = `
  query Session($id: ID!) {
    session(id: $id) {
      id userId controllerId controllerName acpServerType status
      externalSessionId cwd createdAt updatedAt endedAt
      modes { id name description }
      currentModeId
      currentModel { id name provider }
      availableModels { id name provider }
      currentModelId
    }
  }
`;

const SET_SESSION_MODE = `
  mutation SetSessionMode($sessionId: ID!, $modeId: String!) {
    setSessionMode(sessionId: $sessionId, modeId: $modeId)
  }
`;

const SEND_SESSION_MESSAGE = `
  mutation SendSessionMessage($sessionId: ID!, $content: String!, $type: AcpMessageType) {
    sendSessionMessage(sessionId: $sessionId, content: $content, type: $type) {
      id sessionId direction type content metadata createdAt
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
  client.emit('register', { key, hostname: 'sess-test-host', version: '2.0.0' });
  const regData = await registered;
  client.disconnect();

  return { rawKey: key, controllerId: regData.controllerId };
}

async function createWorkspace(ctrlId: string): Promise<string> {
  const path = `/tmp/sess-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await gqlRequest(
    CREATE_WORKSPACE,
    { input: { controllerId: ctrlId, path } },
    authToken,
  );
  const body = await res.json();
  if (body.errors) {
    throw new Error(`createWorkspace failed: ${JSON.stringify(body.errors)} (controllerId=${ctrlId}, path=${path})`);
  }
  return body.data.createWorkspace.id;
}

async function clearWorkspaces(ctrlId: string): Promise<void> {
  await gqlRequest(CLEAR_WORKSPACES, { controllerId: ctrlId }, authToken);
}

describe('Session GraphQL API', () => {
  beforeAll(async () => {
    authToken = await signup();
    expect(authToken).toBeTruthy();

    const ctrl = await createKeyAndRegisterController(authToken);
    rawKey = ctrl.rawKey;
    controllerId = ctrl.controllerId;

    // Clean up any workspaces from previous test runs to avoid hitting MAX_WORKSPACES limit
    await clearWorkspaces(controllerId);
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

    it('should create a new session with github_copilot acpServerType', async () => {
      const wsId = await createWorkspace(controllerId);
      const res = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'github_copilot', workspaceId: wsId } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.createSession.session.id).toBeDefined();
      expect(body.data.createSession.session.status).toBe('creating');
      expect(body.data.createSession.session.acpServerType).toBe('github_copilot');
    });

    it('should create a new session with claude_code acpServerType', async () => {
      const wsId = await createWorkspace(controllerId);
      const res = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'claude_code', workspaceId: wsId } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.createSession.session.id).toBeDefined();
      expect(body.data.createSession.session.status).toBe('creating');
      expect(body.data.createSession.session.acpServerType).toBe('claude_code');
    });

    it('should create a new session with gemini_cli acpServerType', async () => {
      const wsId = await createWorkspace(controllerId);
      const res = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'gemini_cli', workspaceId: wsId } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.createSession.session.id).toBeDefined();
      expect(body.data.createSession.session.status).toBe('creating');
      expect(body.data.createSession.session.acpServerType).toBe('gemini_cli');
    });

    it('should create a new session with codex acpServerType', async () => {
      const wsId = await createWorkspace(controllerId);
      const res = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'codex', workspaceId: wsId } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.createSession.session.id).toBeDefined();
      expect(body.data.createSession.session.status).toBe('creating');
      expect(body.data.createSession.session.acpServerType).toBe('codex');
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
        { sessionId, content: JSON.stringify({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Hello agent' } }), type: 'text' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.sendSessionMessage.direction).toBe('input');
      expect(body.data.sendSessionMessage.content.sessionUpdate).toBe('user_message_chunk');
      expect(body.data.sendSessionMessage.content.content.text).toBe('Hello agent');
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

    it('start 完成前发送的消息应排队，会话激活后补发给 controller（验收#3 回归）', async () => {
      // 独立 fake controller：手动控制 acp:start:result 时机，模拟 harness 慢启动
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `queue-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const freshRawKey = (await keyRes.json()).data.createControllerKey.rawKey;
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: freshRawKey, hostname: 'queue-host', version: '2.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;

      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start', 10000);
      const wsId = await createWorkspace(freshControllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: freshControllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const sessionId = (await createRes.json()).data.createSession.session.id;
      const startData = await startEvent;

      // 会话尚未激活（故意不回 acp:start:result）时立即发消息
      const sendRes = await gqlRequest(
        SEND_SESSION_MESSAGE,
        { sessionId, content: '排队消息', type: 'text' },
        authToken,
      );
      expect((await sendRes.json()).errors).toBeUndefined();

      // 激活前不应转发给 controller（排队中）
      let receivedEarly = false;
      client.on('acp:message', () => { receivedEarly = true; });
      await new Promise((r) => setTimeout(r, 800));
      expect(receivedEarly).toBe(false);

      // start 完成 → 排队消息按序补发
      const messageEvent = waitForEvent<{ sessionId: string; message: { type: string; content: string } }>(
        client,
        'acp:message',
        10000,
      );
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_queue_${Date.now()}`,
      });
      const msg = await messageEvent;
      expect(msg.sessionId).toBe(sessionId);
      expect(msg.message.content).toContain('排队消息');

      client.disconnect();
    }, 20000);
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
        { sessionId, content: JSON.stringify({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'test message' } }), type: 'text' },
        authToken,
      );

      const res = await gqlRequest(
        SESSION_MESSAGES_QUERY,
        { sessionId, limit: 10 },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(Array.isArray(body.data.sessionMessages)).toBe(true);
      expect(body.data.sessionMessages.length).toBeGreaterThan(0);
      expect(body.data.sessionMessages[0].content.sessionUpdate).toBe('user_message_chunk');
    });

    it('should reject query for non-existent session', async () => {
      const res = await gqlRequest(
        SESSION_MESSAGES_QUERY,
        { sessionId: '000000000000000000000000', limit: 10 },
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
    beforeEach(async () => {
      await clearWorkspaces(controllerId);
    });

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
    let capControllerId = '';
    let capClient: ClientSocket;

    beforeAll(async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `cap-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const capKey = keyBody.data.createControllerKey.rawKey;

      capClient = createClient();
      const registered = waitForEvent<{ controllerId: string }>(capClient, 'registered');
      capClient.emit('register', { key: capKey, hostname: 'cap-test-host', version: '2.0.0' });
      const regData = await registered;
      capControllerId = regData.controllerId;
    });

    afterAll(() => {
      capClient?.disconnect();
    });

    it('should reject query without token', async () => {
      const res = await gqlRequest(
        ACP_CAPABILITIES_QUERY,
        { controllerId: capControllerId },
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should return capabilities for controller', async () => {
      const res = await gqlRequest(
        ACP_CAPABILITIES_QUERY,
        { controllerId: capControllerId },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(Array.isArray(body.data.acpCapabilities)).toBe(true);
      if (body.data.acpCapabilities.length > 0) {
        expect(body.data.acpCapabilities[0]).toHaveProperty('checkedAt');
      }
    }, 20_000);

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

  describe('refreshAcpCapabilities mutation', () => {
    let refreshControllerId = '';
    let refreshClient: ClientSocket;

    beforeAll(async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `refresh-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const key = keyBody.data.createControllerKey.rawKey;

      refreshClient = createClient();
      const registered = waitForEvent<{ controllerId: string }>(refreshClient, 'registered');
      refreshClient.emit('register', { key, hostname: 'refresh-test-host', version: '2.0.0' });
      const regData = await registered;
      refreshControllerId = regData.controllerId;
    });

    afterAll(() => {
      refreshClient?.disconnect();
    });

    it('should reject mutation without token', async () => {
      const res = await gqlRequest(
        REFRESH_ACP_CAPABILITIES_MUTATION,
        { controllerId: refreshControllerId },
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject mutation for non-existent controller', async () => {
      const res = await gqlRequest(
        REFRESH_ACP_CAPABILITIES_MUTATION,
        { controllerId: '000000000000000000000000' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
    });

    it('should return capabilities after refresh', async () => {
      const res = await gqlRequest(
        REFRESH_ACP_CAPABILITIES_MUTATION,
        { controllerId: refreshControllerId },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(Array.isArray(body.data.refreshAcpCapabilities)).toBe(true);
      if (body.data.refreshAcpCapabilities.length > 0) {
        expect(body.data.refreshAcpCapabilities[0]).toHaveProperty('checkedAt');
      }
    }, 20_000);
  });

  describe('setSessionConfigOption mutation', () => {
    it('should reject without auth', async () => {
      const res = await gqlRequest(SET_SESSION_CONFIG_OPTION, {
        sessionId: '000000000000000000000000',
        configId: 'autosave',
        value: 'true',
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should return false for non-existent session', async () => {
      const res = await gqlRequest(SET_SESSION_CONFIG_OPTION, {
        sessionId: '000000000000000000000000',
        configId: 'autosave',
        value: 'true',
      }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.setSessionConfigOption).toBe(false);
    });

    it('should return false when session is not idling', async () => {
      const wsId = await createWorkspace(controllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;

      // Session is in 'creating' (not idling) — mutation should return false
      const res = await gqlRequest(SET_SESSION_CONFIG_OPTION, {
        sessionId,
        configId: 'autosave',
        value: 'true',
      }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.setSessionConfigOption).toBe(false);
    });

    it('should publish acp:set-config-option to controller when session is idling', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `cfgopt-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const freshRawKey = keyBody.data.createControllerKey.rawKey;

      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: freshRawKey, hostname: 'cfgopt-host', version: '2.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;

      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start', 10000);
      const wsId = await createWorkspace(freshControllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: freshControllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const sessionId = (await createRes.json()).data.createSession.session.id;

      const startData = await startEvent;
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_cfgopt_${Date.now()}`,
        configOptions: [
          { id: 'autosave', name: 'Autosave', type: 'boolean', currentValue: 'false' },
        ],
      });
      await new Promise((r) => setTimeout(r, 500));

      // Verify session is idling
      const sessionRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const sessionBody = await sessionRes.json();
      expect(sessionBody.data.session.status).toBe('idling');

      // Listen for acp:set-config-option on the controller socket
      const setOptionEvent = waitForEvent<{
        sessionId: string;
        configId: string;
        value: string;
      }>(client, 'acp:set-config-option', 10000);

      const res = await gqlRequest(SET_SESSION_CONFIG_OPTION, {
        sessionId,
        configId: 'autosave',
        value: 'true',
      }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.setSessionConfigOption).toBe(true);

      const setData = await setOptionEvent;
      expect(setData.sessionId).toBe(sessionId);
      expect(setData.configId).toBe('autosave');
      expect(setData.value).toBe('true');

      client.disconnect();
    });
  });

  describe('deleteHistorySession mutation', () => {
    it('should reject without auth', async () => {
      const res = await gqlRequest(DELETE_HISTORY_SESSION, {
        sessionId: '000000000000000000000000',
        syncAgent: false,
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should return error for non-existent session', async () => {
      const res = await gqlRequest(DELETE_HISTORY_SESSION, {
        sessionId: '000000000000000000000000',
        syncAgent: false,
      }, authToken);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Session not found');
    });

    it('should delete local session with syncAgent=false without syncing to agent', async () => {
      const wsId = await createWorkspace(controllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const sessionId = (await createRes.json()).data.createSession.session.id;

      const res = await gqlRequest(DELETE_HISTORY_SESSION, {
        sessionId,
        syncAgent: false,
      }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.deleteHistorySession.success).toBe(true);
      expect(body.data.deleteHistorySession.syncedToAgent).toBe(false);

      const sessionRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const sessionBody = await sessionRes.json();
      expect(sessionBody.data.session).toBeNull();
    });

    it('should sync delete to agent when externalSessionId present and controller supports it', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `delhist-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const freshRawKey = keyBody.data.createControllerKey.rawKey;

      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: freshRawKey, hostname: 'delhist-host', version: '2.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;

      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start', 10000);
      const wsId = await createWorkspace(freshControllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: freshControllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const sessionId = (await createRes.json()).data.createSession.session.id;

      const startData = await startEvent;
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_delhist_${Date.now()}`,
      });
      await new Promise((r) => setTimeout(r, 500));

      // 存活会话删除前必须先停 ACP 进程：fake controller 像真实 controller 一样 ack acp:stop
      const stopEvent = waitForEvent<{ sessionId: string; ackRequired?: boolean }>(client, 'acp:stop', 10000);
      client.on('acp:stop', (data: { sessionId: string }) => {
        client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_delete' });
      });

      // Listen for acp:delete-history-session on the controller socket
      const deleteEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
        externalSessionId: string;
        serverType: string;
      }>(client, 'acp:delete-history-session', 10000);

      const deletePromise = gqlRequest(DELETE_HISTORY_SESSION, {
        sessionId,
        syncAgent: true,
      }, authToken);

      // 先收到 acp:stop（停 ACP 进程），再收到 acp:delete-history-session（同步历史删除）
      const stopData = await stopEvent;
      expect(stopData.sessionId).toBe(sessionId);

      const deleteData = await deleteEvent;
      expect(deleteData.sessionId).toBe(sessionId);
      expect(deleteData.externalSessionId).toBeDefined();

      client.emit('acp:delete-history-session:result', {
        requestId: deleteData.requestId,
        sessionId: deleteData.sessionId,
        success: true,
        supported: true,
      });

      const body = await (await deletePromise).json();
      expect(body.errors).toBeUndefined();
      expect(body.data.deleteHistorySession.success).toBe(true);
      expect(body.data.deleteHistorySession.syncedToAgent).toBe(true);

      const sessionRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const sessionBody = await sessionRes.json();
      expect(sessionBody.data.session).toBeNull();

      client.disconnect();
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
    await clearWorkspaces(controllerId);
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
      headers: { Authorization: `Bearer ${authToken}`, 'Accept-Encoding': 'identity' },
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

    // Verify history event contains at most 25 messages
    const historyMatch = text.match(/data: ({.*?"type":"history".*?})\n/);
    if (historyMatch) {
      const historyData = JSON.parse(historyMatch[1]);
      expect(historyData.data.length).toBeLessThanOrEqual(25);
    }

    reader.cancel();
    controller.abort();
  });

  it('should include modes in initial SSE status event after ACP start with modes', async () => {
    const keyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `sse-modes-key-${Date.now()}`, type: 'local' } },
      authToken,
    );
    const keyBody = await keyRes.json();
    const freshRawKey = keyBody.data.createControllerKey.rawKey;

    const client = createClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: freshRawKey, hostname: 'sse-modes-host', version: '2.0.0' });
    const regData = await registered;
    const freshControllerId = regData.controllerId;

    const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start', 10000);
    const wsId = await createWorkspace(freshControllerId);
    const createRes = await gqlRequest(
      CREATE_SESSION,
      { input: { controllerId: freshControllerId, acpServerType: 'opencode', workspaceId: wsId } },
      authToken,
    );
    const sessionId = (await createRes.json()).data.createSession.session.id;

    const startData = await startEvent;
    client.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId,
      success: true,
      externalSessionId: `ext_sse_modes_${Date.now()}`,
      modes: [{ id: 'code', name: 'Code', description: 'Coding mode' }],
      currentModeId: 'code',
      currentModel: { id: 'gpt-4', name: 'GPT-4' },
    });
    await new Promise((r) => setTimeout(r, 500));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`${SSE_BASE_URL}/api/session/${sessionId}/stream`, {
      headers: { Authorization: `Bearer ${authToken}`, 'Accept-Encoding': 'identity' },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const text = decoder.decode(value);

    // Find the initial status event (before history)
    const events = text.split('\n').filter((l) => l.startsWith('data: '));
    const statusEvent = events
      .map((l) => JSON.parse(l.slice(6)))
      .find((e) => e.type === 'status');
    expect(statusEvent).toBeDefined();
    expect(statusEvent.data.status).toBe('idling');
    expect(statusEvent.data.modes).toBeDefined();
    expect(statusEvent.data.modes[0].id).toBe('code');
    expect(statusEvent.data.modes[0].name).toBe('Code');
    expect(statusEvent.data.currentModeId).toBe('code');
    expect(statusEvent.data.currentModel).toBeDefined();
    expect(statusEvent.data.currentModel.id).toBe('gpt-4');

    reader.cancel();
    controller.abort();
    client.disconnect();
  }, 20_000);

  it('should stream rapidly emitted messages in arrival order', async () => {
    const keyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `sse-order-key-${Date.now()}`, type: 'local' } },
      authToken,
    );
    const keyBody = await keyRes.json();
    const freshRawKey = keyBody.data.createControllerKey.rawKey;

    const client = createClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: freshRawKey, hostname: 'sse-order-host', version: '2.0.0' });
    const regData = await registered;
    const freshControllerId = regData.controllerId;

    const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start', 10000);
    const wsId = await createWorkspace(freshControllerId);
    const createRes = await gqlRequest(
      CREATE_SESSION,
      { input: { controllerId: freshControllerId, acpServerType: 'opencode', workspaceId: wsId } },
      authToken,
    );
    const sessionId = (await createRes.json()).data.createSession.session.id;

    const startData = await startEvent;
    client.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId,
      success: true,
      externalSessionId: `ext_sse_order_${Date.now()}`,
    });
    await new Promise((r) => setTimeout(r, 500));

    const controller = new AbortController();
    const res = await fetch(`${SSE_BASE_URL}/api/session/${sessionId}/stream`, {
      headers: { Authorization: `Bearer ${authToken}`, 'Accept-Encoding': 'identity' },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);

    // 等待 SSE 订阅就绪后，高频连发 5 条消息（模拟 agent 快速输出）
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 1; i <= 5; i++) {
      client.emit('acp:message', {
        sessionId,
        message: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `seq-${i}` },
        },
      });
    }

    // 收集 SSE 推送的 message 事件
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const received: string[] = [];
    const deadline = Date.now() + 8000;
    while (received.length < 5 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const evt = JSON.parse(line.slice(6));
        if (evt.type !== 'message' || typeof evt.data?.content !== 'string') continue;
        if (!evt.data.content.includes('seq-')) continue;
        const update = JSON.parse(evt.data.content);
        received.push(update.content.text);
      }
    }

    reader.cancel();
    controller.abort();
    client.disconnect();

    expect(received).toEqual(['seq-1', 'seq-2', 'seq-3', 'seq-4', 'seq-5']);
  }, 20_000);

  it('should return non-empty modes and models in both GraphQL and SSE after acp:start:result', async () => {
    const keyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `modes-both-key-${Date.now()}`, type: 'local' } },
      authToken,
    );
    const keyBody = await keyRes.json();
    const freshRawKey = keyBody.data.createControllerKey.rawKey;

    const client = createClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: freshRawKey, hostname: 'modes-both-host', version: '2.0.0' });
    const regData = await registered;
    const freshControllerId = regData.controllerId;

    const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start', 10000);
    const wsId = await createWorkspace(freshControllerId);
    const createRes = await gqlRequest(
      CREATE_SESSION,
      { input: { controllerId: freshControllerId, acpServerType: 'opencode', workspaceId: wsId } },
      authToken,
    );
    const sessionId = (await createRes.json()).data.createSession.session.id;

    const startData = await startEvent;
    client.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId,
      success: true,
      externalSessionId: `ext_modes_both_${Date.now()}`,
      modes: [{ id: 'code', name: 'Code', description: 'Coding mode' }],
      currentModeId: 'code',
      currentModel: { id: 'gpt-4', name: 'GPT-4', provider: 'openai' },
      availableModels: [{ id: 'gpt-4', name: 'GPT-4', provider: 'openai' }],
      currentModelId: 'gpt-4',
    });
    // Wait for controller-api to process and save to DB
    await new Promise((r) => setTimeout(r, 500));

    // 1) Verify GraphQL returns non-empty modes/models
    const gqlRes = await gqlRequest(SESSION_WITH_MODES_QUERY, { id: sessionId }, authToken);
    const gqlBody = await gqlRes.json();
    expect(gqlBody.errors).toBeUndefined();
    const session = gqlBody.data.session;
    expect(session.status).toBe('idling');

    expect(session.modes).toBeDefined();
    expect(session.modes.length).toBeGreaterThan(0);
    expect(session.modes[0].id).toBe('code');
    expect(session.modes[0].name).toBe('Code');

    expect(session.currentModeId).toBe('code');

    expect(session.currentModel).toBeDefined();
    expect(session.currentModel.id).toBe('gpt-4');
    expect(session.currentModel.name).toBe('GPT-4');

    expect(session.availableModels).toBeDefined();
    expect(session.availableModels.length).toBeGreaterThan(0);
    expect(session.availableModels[0].id).toBe('gpt-4');
    expect(session.availableModels[0].name).toBe('GPT-4');

    expect(session.currentModelId).toBe('gpt-4');

    // 2) Verify SSE initial status event also contains non-empty modes/models
    const sseController = new AbortController();
    const sseTimeout = setTimeout(() => sseController.abort(), 3000);
    const sseRes = await fetch(`${SSE_BASE_URL}/api/session/${sessionId}/stream`, {
      headers: { Authorization: `Bearer ${authToken}`, 'Accept-Encoding': 'identity' },
      signal: sseController.signal,
    });
    clearTimeout(sseTimeout);

    expect(sseRes.status).toBe(200);
    const sseReader = sseRes.body!.getReader();
    const sseDecoder = new TextDecoder();
    const { value: sseValue } = await sseReader.read();
    const sseText = sseDecoder.decode(sseValue);

    const sseEvents = sseText.split('\n').filter((l) => l.startsWith('data: '));
    const sseStatusEvent = sseEvents
      .map((l) => JSON.parse(l.slice(6)))
      .find((e) => e.type === 'status');
    expect(sseStatusEvent).toBeDefined();
    expect(sseStatusEvent.data.status).toBe('idling');

    expect(sseStatusEvent.data.modes).toBeDefined();
    expect(sseStatusEvent.data.modes.length).toBeGreaterThan(0);
    expect(sseStatusEvent.data.modes[0].id).toBe('code');

    expect(sseStatusEvent.data.currentModeId).toBe('code');

    expect(sseStatusEvent.data.currentModel).toBeDefined();
    expect(sseStatusEvent.data.currentModel.id).toBe('gpt-4');

    expect(sseStatusEvent.data.availableModels).toBeDefined();
    expect(sseStatusEvent.data.availableModels.length).toBeGreaterThan(0);

    expect(sseStatusEvent.data.currentModelId).toBe('gpt-4');

    sseReader.cancel();
    sseController.abort();
    client.disconnect();
  }, 30_000);
});

  describe('Session WebSocket ACP Events', () => {
  beforeAll(async () => {
    if (!authToken) {
      authToken = await signup();
      const ctrl = await createKeyAndRegisterController(authToken);
      rawKey = ctrl.rawKey;
      controllerId = ctrl.controllerId;
    }

    // Clean up workspaces to avoid hitting MAX_WORKSPACES limit
    await clearWorkspaces(controllerId);
  });

  it('should handle acp:check result from controller', async () => {
    const client = createClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: rawKey, hostname: 'sess-test-host', version: '2.0.0' });
    await registered;

    // Controller sends acp:check:result (simulating response to server's acp:check)
    client.emit('acp:check:result', {
      requestId: 'test-req-1',
      servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
    });

    await new Promise((r) => setTimeout(r, 200));
    client.disconnect();
  });

  it('should handle acp:check result with multiple servers from controller', async () => {
    const client = createClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: rawKey, hostname: 'sess-test-host', version: '2.0.0' });
    await registered;

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

  it('should handle acp:start and acp:stop flow', async () => {
    const client = createClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: rawKey, hostname: 'sess-test-host', version: '2.0.0' });
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

  describe('setSessionMode', () => {
    it('should reject setSessionMode without auth', async () => {
      const res = await gqlRequest(SET_SESSION_MODE, {
        sessionId: '000000000000000000000000',
        modeId: 'mode-1',
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should return false for setSessionMode on non-idling session', async () => {
      // Register controller
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `setmode-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const freshRawKey = keyBody.data.createControllerKey.rawKey;

      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: freshRawKey, hostname: 'setmode-host', version: '2.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;

      // Create session — status will be 'creating' (not idling)
      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start', 10000);
      const wsId = await createWorkspace(freshControllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: freshControllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;

      const startData = await startEvent;

      // Session is still 'connecting' (not yet responded) — setSessionMode should fail
      const res = await gqlRequest(
        SET_SESSION_MODE,
        { sessionId, modeId: 'mode-1' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.setSessionMode).toBe(false);

      // Now respond with acp:start:result to clean up
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
      });
      await new Promise((r) => setTimeout(r, 300));
      client.disconnect();
    });

    it('should handle setSessionMode on idling session via resume flow', async () => {
      // Register controller
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `setmode-idle-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const freshRawKey = keyBody.data.createControllerKey.rawKey;

      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: freshRawKey, hostname: 'setmode-idle-host', version: '2.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;

      // 生命周期命令（start/stop/resume）按序串行处理：close 的 acp:stop 未 ack 会阻塞后续 resume
      client.on('acp:stop', (data: { sessionId: string }) => {
        client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_close' });
      });

      // Create session with modes in start result
      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start', 10000);
      const wsId = await createWorkspace(freshControllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: freshControllerId, acpServerType: 'opencode', workspaceId: wsId } },
        authToken,
      );
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;

      const startData = await startEvent;
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_setmode_${Date.now()}`,
        modes: [{ id: 'code', name: 'Code', description: 'Coding mode' }],
        currentModeId: 'code',
        currentModel: { id: 'gpt-4', name: 'GPT-4' },
      });
      await new Promise((r) => setTimeout(r, 500));

      // Verify modes are in the session
      let sessionRes = await gqlRequest(SESSION_WITH_MODES_QUERY, { id: sessionId }, authToken);
      let sessionBody = await sessionRes.json();
      expect(sessionBody.errors).toBeUndefined();
      expect(sessionBody.data.session.status).toBe('idling');
      expect(sessionBody.data.session.modes).toBeDefined();
      expect(sessionBody.data.session.modes[0].id).toBe('code');
      expect(sessionBody.data.session.currentModeId).toBe('code');
      expect(sessionBody.data.session.currentModel.id).toBe('gpt-4');

      // Close session to get ended status
      await gqlRequest(CLOSE_SESSION, { id: sessionId }, authToken);

      // Resume into idling state
      const resumeEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:resume', 10000);
      await gqlRequest(RESUME_SESSION, { id: sessionId }, authToken);

      const resumeData = await resumeEvent;
      client.emit('acp:resume:result', {
        requestId: resumeData.requestId,
        sessionId,
        success: true,
      });
      await new Promise((r) => setTimeout(r, 500));

      // Verify session is idling
      sessionRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      sessionBody = await sessionRes.json();
      expect(sessionBody.data.session.status).toBe('idling');

      // Call setSessionMode — should return true (async, no sync result)
      const modeRes = await gqlRequest(
        SET_SESSION_MODE,
        { sessionId, modeId: 'code' },
        authToken,
      );
      const modeBody = await modeRes.json();
      expect(modeBody.errors).toBeUndefined();
      // Returns true because it validated session ownership + idling status
      expect(modeBody.data.setSessionMode).toBe(true);

      client.disconnect();
    });
  });

  describe('End-to-end: createSession → acp:start → controller respond → verify status', () => {
    it('should create github_copilot session and send acp:start with correct serverType', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `e2e-gc-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const freshRawKey = keyBody.data.createControllerKey.rawKey;

      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: freshRawKey, hostname: 'e2e-gc-host', version: '2.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;

      const startEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
        serverType: string;
        cwd: string;
      }>(client, 'acp:start', 10000);

      const wsId = await createWorkspace(freshControllerId);
      const createRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: freshControllerId, acpServerType: 'github_copilot', workspaceId: wsId } },
        authToken,
      );
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;
      expect(createBody.data.createSession.session.acpServerType).toBe('github_copilot');

      const startData = await startEvent;
      expect(startData.sessionId).toBe(sessionId);
      expect(startData.serverType).toBe('github_copilot');

      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_gc_${Date.now()}`,
      });

      await new Promise((r) => setTimeout(r, 500));

      const sessionRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const sessionBody = await sessionRes.json();
      expect(sessionBody.data.session.status).toBe('idling');

      client.disconnect();
    });

    it('should update session status to idling after controller responds', async () => {
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
      client.emit('register', { key: freshRawKey, hostname: 'e2e-host', version: '2.0.0' });
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

      // 6. Verify session status changed to idling via GraphQL query

      const sessionRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const sessionBody = await sessionRes.json();
      expect(sessionBody.errors).toBeUndefined();
      expect(sessionBody.data.session.status).toBe('idling');
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
      client.emit('register', { key: freshRawKey, hostname: 'e2e-fail-host', version: '2.0.0' });
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
      client.emit('register', { key: freshRawKey, hostname: 'resume-e2e-host', version: '2.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;

      // 生命周期命令（start/stop/resume）按序串行处理：close 的 acp:stop 未 ack 会阻塞后续 resume，
      // fake controller 须像真实 controller 一样 ack acp:stop
      client.on('acp:stop', (data: { sessionId: string }) => {
        client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_close' });
      });

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
      client.emit('register', { key: freshRawKey, hostname: 'resume-fail-host', version: '2.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;

      // 生命周期命令（start/stop/resume）按序串行处理：close 的 acp:stop 未 ack 会阻塞后续 resume，
      // fake controller 须像真实 controller 一样 ack acp:stop
      client.on('acp:stop', (data: { sessionId: string }) => {
        client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_close' });
      });

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
      client.emit('register', { key: freshRawKey, hostname: 'e2e-msg-host', version: '2.0.0' });
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

      const msgContent = JSON.stringify({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Hello agent' } });
      // Send message via GraphQL → controller-api forwards to controller
      const msgRes = await gqlRequest(
        SEND_SESSION_MESSAGE,
        { sessionId, content: msgContent, type: 'text' },
        authToken,
      );
      const msgBody = await msgRes.json();
      expect(msgBody.data.sendSessionMessage.direction).toBe('input');
      // agent-api stores content as parsed JSON object
      expect(msgBody.data.sendSessionMessage.content.sessionUpdate).toBe('user_message_chunk');
      expect(msgBody.data.sendSessionMessage.content.content.text).toBe('Hello agent');

      // Fake controller receives the message
      const msgData = await messageEvent;
      expect(msgData.sessionId).toBe(sessionId);
      // controller-api forwards the raw user content string
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
        { sessionId, limit: 10 },
        authToken,
      );
      const messagesBody = await messagesRes.json();
      const messages = messagesBody.data.sessionMessages;
      expect(messages.length).toBeGreaterThanOrEqual(2);

      const inputMsg = messages.find((m: { direction: string; content: Record<string, unknown> }) => m.direction === 'input');
      const outputMsg = messages.find((m: { direction: string; content: Record<string, unknown> }) => m.direction === 'output');
      expect(inputMsg).toBeDefined();
      expect(outputMsg).toBeDefined();
      // Content is now stored as JSON object, not string
      expect(outputMsg.content.sessionUpdate).toBe('agent_message_chunk');
      expect(outputMsg.content.content.text).toBe('Hello human');

      client.disconnect();
    });
  });

  describe('createSession with enableWorktree', () => {
    const CREATE_SESSION_WITH_WORKTREE = `
      mutation CreateSession($input: CreateSessionInput!) {
        createSession(input: $input) {
          session {
            id userId controllerId controllerName acpServerType status
            externalSessionId cwd worktreePath worktreeBranch createdAt updatedAt endedAt
          }
        }
      }
    `;

    it('should create session with enableWorktree and wait for git:worktree:add', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `wt-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const freshRawKey = keyBody.data.createControllerKey.rawKey;

      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: freshRawKey, hostname: 'wt-test-host', version: '2.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;

      const wsId = await createWorkspace(freshControllerId);
      const wsRes = await gqlRequest(
        `
          mutation SetDefaultBranch($id: ID!, $defaultBranch: String!) {
            setWorkspaceDefaultBranch(id: $id, defaultBranch: $defaultBranch) {
              id defaultBranch
            }
          }
        `,
        { id: wsId, defaultBranch: 'main' },
        authToken,
      );
      expect(wsRes.status).toBe(200);

      const worktreeAdd = waitForEvent<{
        requestId: string;
        repoPath: string;
        worktreePath: string;
        branch: string;
      }>(client, 'git:worktree:add', 10000);

      const createPromise = gqlRequest(
        CREATE_SESSION_WITH_WORKTREE,
        {
          input: {
            controllerId: freshControllerId,
            acpServerType: 'opencode',
            workspaceId: wsId,
            enableWorktree: true,
            worktreeBranchSuffix: 'feat/new-feature',
          },
        },
        authToken,
      );

      const wtData = await worktreeAdd;
      expect(wtData.repoPath).toBeDefined();
      expect(wtData.worktreePath).toContain('worktrees');
      expect(wtData.branch).toContain('feat/new-feature');

      client.emit('git:worktree:add:result', {
        requestId: wtData.requestId,
        success: true,
        path: wtData.worktreePath,
        branch: wtData.branch,
      });

      const createRes = await createPromise;
      const createBody = await createRes.json();
      const sessionId = createBody.data.createSession.session.id;
      expect(createBody.data.createSession.session.status).toBe('creating');

      await new Promise((r) => setTimeout(r, 500));

      const sessionRes = await gqlRequest(
        `query Session($id: ID!) { session(id: $id) { id worktreePath worktreeBranch status } }`,
        { id: sessionId },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      expect(sessionBody.data.session.worktreePath).toBe(wtData.worktreePath);
      expect(sessionBody.data.session.worktreeBranch).toBe(wtData.branch);

      client.disconnect();
    }, 30000);

    it('should create session with enableWorktree and custom branch suffix', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `wt-custom-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const freshRawKey = keyBody.data.createControllerKey.rawKey;

      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: freshRawKey, hostname: 'wt-custom-host', version: '2.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;
      const wsId = await createWorkspace(freshControllerId);

      const worktreeAdd = waitForEvent<{
        requestId: string;
        branch: string;
      }>(client, 'git:worktree:add', 10000);

      const createPromise = gqlRequest(
        CREATE_SESSION_WITH_WORKTREE,
        {
          input: {
            controllerId: freshControllerId,
            acpServerType: 'opencode',
            workspaceId: wsId,
            enableWorktree: true,
            worktreeBranchSuffix: 'custom-branch',
          },
        },
        authToken,
      );

      const wtData = await worktreeAdd;
      expect(wtData.branch).toContain('custom-branch');

      client.emit('git:worktree:add:result', {
        requestId: wtData.requestId,
        success: true,
        path: '/tmp/worktree',
        branch: wtData.branch,
      });

      await createPromise;
      client.disconnect();
    }, 30000);

    it('should handle git:worktree:add failure and set session to ended', async () => {
      const keyRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `wt-fail-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const keyBody = await keyRes.json();
      const freshRawKey = keyBody.data.createControllerKey.rawKey;

      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: freshRawKey, hostname: 'wt-fail-host', version: '2.0.0' });
      const regData = await registered;
      const freshControllerId = regData.controllerId;
      const wsId = await createWorkspace(freshControllerId);

      const worktreeAdd = waitForEvent<{
        requestId: string;
      }>(client, 'git:worktree:add', 10000);

      const createPromise = gqlRequest(
        CREATE_SESSION_WITH_WORKTREE,
        {
          input: {
            controllerId: freshControllerId,
            acpServerType: 'opencode',
            workspaceId: wsId,
            enableWorktree: true,
            worktreeBranchSuffix: 'feat/fail',
          },
        },
        authToken,
      );

      const wtData = await worktreeAdd;

      client.emit('git:worktree:add:result', {
        requestId: wtData.requestId,
        success: false,
        error: 'Git worktree add failed',
      });

      const createRes = await createPromise;
      const createBody = await createRes.json();
      expect(createBody.errors).toBeDefined();
      expect(createBody.errors[0].message).toContain('WORKTREE_ADD_FAILED');

      client.disconnect();
    }, 30000);
  });
});
