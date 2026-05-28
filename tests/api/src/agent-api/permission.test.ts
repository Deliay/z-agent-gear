import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

const GET_TODO_LIST = `
  query GetTodoList {
    getTodoList {
      id
      type
      priority
      title
      description
      isRead
      data {
        requestId
        sessionId
        toolCallId
        options {
          optionId
          name
          kind
        }
      }
      createdAt
    }
  }
`;

const GET_UNREAD_TODO_COUNT = `
  query GetUnreadTodoCount {
    getUnreadTodoCount
  }
`;

const RESPOND_PERMISSION = `
  mutation RespondPermission($requestId: String!, $outcome: String!, $optionId: String) {
    respondPermission(requestId: $requestId, outcome: $outcome, optionId: $optionId)
  }
`;

const MARK_TODO_READ = `
  mutation MarkTodoRead($todoId: ID!) {
    markTodoRead(todoId: $todoId)
  }
`;

const MARK_ALL_TODO_READ = `
  mutation MarkAllTodoRead {
    markAllTodoRead
  }
`;

const UPDATE_PERMISSION_TIMEOUT = `
  mutation UpdatePermissionTimeout($sessionId: ID, $timeoutAction: PermissionTimeoutAction!) {
    updatePermissionTimeout(sessionId: $sessionId, timeoutAction: $timeoutAction)
  }
`;

const UPDATE_GLOBAL_PERMISSION_TIMEOUT = `
  mutation UpdateGlobalPermissionTimeout($timeoutAction: GlobalPermissionTimeoutAction!) {
    updateGlobalPermissionTimeout(timeoutAction: $timeoutAction)
  }
`;

const SESSION_QUERY = `
  query Session($id: ID!) {
    session(id: $id) {
      id status permissionTimeoutAction
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
let controllerId = '';
let client: ClientSocket;

async function createFreshController(): Promise<{ rawKey: string; controllerId: string; client: ClientSocket }> {
  const keyRes = await gqlRequest(
    CREATE_KEY,
    { input: { name: `perm-${Date.now()}`, type: 'local' } },
    authToken,
  );
  const keyBody = await keyRes.json();
  const rawKey = keyBody.data.createControllerKey.rawKey;

  const client = createClient();
  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', { key: rawKey, hostname: 'perm-test-host', version: '1.0.0' });
  const regData = await registered;

  return { rawKey, controllerId: regData.controllerId, client };
}

async function createWorkspace(ctrlId: string): Promise<string> {
  const res = await gqlRequest(
    CREATE_WORKSPACE,
    { input: { controllerId: ctrlId, path: `/tmp/perm-test-${Date.now()}` } },
    authToken,
  );
  const body = await res.json();
  return body.data.createWorkspace.id;
}

describe('ACP Permission Reminder API', () => {
  beforeAll(async () => {
    const uid = `perm_${Date.now().toString(36)}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token ?? '';
    expect(authToken).toBeTruthy();
  });

  describe('Todo Queries', () => {
    it('should reject getTodoList without auth', async () => {
      const res = await gqlRequest(GET_TODO_LIST);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject getUnreadTodoCount without auth', async () => {
      const res = await gqlRequest(GET_UNREAD_TODO_COUNT);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should return empty todo list initially', async () => {
      const res = await gqlRequest(GET_TODO_LIST, undefined, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(Array.isArray(body.data.getTodoList)).toBe(true);
    });

    it('should return zero unread count initially', async () => {
      const res = await gqlRequest(GET_UNREAD_TODO_COUNT, undefined, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.getUnreadTodoCount).toBe(0);
    });
  });

  describe('Todo Mutations', () => {
    it('should reject respondPermission without auth', async () => {
      const res = await gqlRequest(RESPOND_PERMISSION, {
        requestId: 'test-req-1',
        outcome: 'selected',
        optionId: 'allow-once',
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject markTodoRead without auth', async () => {
      const res = await gqlRequest(MARK_TODO_READ, { todoId: '000000000000000000000000' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject markAllTodoRead without auth', async () => {
      const res = await gqlRequest(MARK_ALL_TODO_READ);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject updatePermissionTimeout without auth', async () => {
      const res = await gqlRequest(UPDATE_PERMISSION_TIMEOUT, {
        sessionId: '000000000000000000000000',
        timeoutAction: 'allow_once',
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject updateGlobalPermissionTimeout without auth', async () => {
      const res = await gqlRequest(UPDATE_GLOBAL_PERMISSION_TIMEOUT, {
        timeoutAction: 'allow_once',
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('Permission Request Flow', () => {
    it('should create todo when controller sends acp:permission', async () => {
      const { controllerId: ctrlId, client: ctrlClient } = await createFreshController();
      const workspaceId = await createWorkspace(ctrlId);

      // Create session first
      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: ctrlId, acpServerType: 'opencode', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      // Wait for acp:start and respond
      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(ctrlClient, 'acp:start', 10000);
      const startData = await startEvent;
      ctrlClient.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });

      await new Promise((r) => setTimeout(r, 500));

      // Simulate permission request from controller
      const permissionRequestId = `perm_${Date.now()}`;
      ctrlClient.emit('acp:permission', {
        requestId: permissionRequestId,
        sessionId,
        toolCall: { toolCallId: 'call_001' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });

      // Wait for todo to be created (poll up to 10 seconds)
      let todo: any = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const todoRes = await gqlRequest(GET_TODO_LIST, undefined, authToken);
        const todoBody = await todoRes.json();
        if (todoBody.data?.getTodoList) {
          todo = todoBody.data.getTodoList.find((t: any) => t.data?.requestId === permissionRequestId);
          if (todo) break;
        }
      }

      expect(todo).toBeDefined();
      expect(todo.type).toBe('permission_request');
      expect(todo.priority).toBe('immediate');
      expect(todo.title).toBe('Agent请求权限审批');
      expect(todo.data.toolCallId).toBe('call_001');
      expect(todo.data.options).toHaveLength(2);

      // Check unread count
      const countRes = await gqlRequest(GET_UNREAD_TODO_COUNT, undefined, authToken);
      const countBody = await countRes.json();
      expect(countBody.data.getUnreadTodoCount).toBeGreaterThan(0);

      ctrlClient.disconnect();
    });

    it('should respond to permission request and receive response on controller', async () => {
      const { controllerId: ctrlId, client: ctrlClient } = await createFreshController();
      const workspaceId = await createWorkspace(ctrlId);

      // Create session
      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: ctrlId, acpServerType: 'opencode', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      // Wait for acp:start and respond
      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(ctrlClient, 'acp:start', 10000);
      const startData = await startEvent;
      ctrlClient.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });

      await new Promise((r) => setTimeout(r, 500));

      // Send permission request
      const permissionRequestId = `perm_resp_${Date.now()}`;
      const permissionResponseEvent = waitForEvent<{ requestId: string; outcome: any }>(
        ctrlClient,
        'acp:permission:response',
        10000,
      );

      ctrlClient.emit('acp:permission', {
        requestId: permissionRequestId,
        sessionId,
        toolCall: { toolCallId: 'call_002' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });

      await new Promise((r) => setTimeout(r, 500));

      // Respond via GraphQL
      const respondRes = await gqlRequest(
        RESPOND_PERMISSION,
        { requestId: permissionRequestId, outcome: 'selected', optionId: 'allow-once' },
        authToken,
      );
      const respondBody = await respondRes.json();
      expect(respondBody.errors).toBeUndefined();
      expect(respondBody.data.respondPermission).toBe(true);

      // Controller should receive the response
      const responseData = await permissionResponseEvent;
      expect(responseData.requestId).toBe(permissionRequestId);
      expect(responseData.outcome.outcome).toBe('selected');
      expect(responseData.outcome.optionId).toBe('allow-once');

      ctrlClient.disconnect();
    });

    it('should handle permission timeout', async () => {
      const { controllerId: ctrlId, client: ctrlClient } = await createFreshController();
      const workspaceId = await createWorkspace(ctrlId);

      // Create session
      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: ctrlId, acpServerType: 'opencode', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      // Wait for acp:start and respond
      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(ctrlClient, 'acp:start', 10000);
      const startData = await startEvent;
      ctrlClient.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });

      await new Promise((r) => setTimeout(r, 500));

      // Send permission request
      const permissionRequestId = `perm_timeout_${Date.now()}`;
      const permissionResponseEvent = waitForEvent<{ requestId: string; outcome: any }>(
        ctrlClient,
        'acp:permission:response',
        65000, // Wait for timeout
      );

      ctrlClient.emit('acp:permission', {
        requestId: permissionRequestId,
        sessionId,
        toolCall: { toolCallId: 'call_timeout' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        ],
      });

      // Wait for timeout (60 seconds on server side)
      const responseData = await permissionResponseEvent;
      expect(responseData.requestId).toBe(permissionRequestId);
      expect(responseData.outcome.outcome).toBe('cancelled');

      ctrlClient.disconnect();
    }, 70000); // Extended timeout for this test
  });

  describe('Todo Management', () => {
    it('should mark todo as read', async () => {
      const { controllerId: ctrlId, client: ctrlClient } = await createFreshController();
      const workspaceId = await createWorkspace(ctrlId);

      // Create session
      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: ctrlId, acpServerType: 'opencode', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      // Wait for acp:start and respond
      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(ctrlClient, 'acp:start', 10000);
      const startData = await startEvent;
      ctrlClient.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });

      await new Promise((r) => setTimeout(r, 500));

      // Create a permission request
      const permissionRequestId = `perm_read_${Date.now()}`;
      ctrlClient.emit('acp:permission', {
        requestId: permissionRequestId,
        sessionId,
        toolCall: { toolCallId: 'call_read' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        ],
      });

      // Wait for todo to be created (poll up to 10 seconds)
      let todo: any = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const todoRes = await gqlRequest(GET_TODO_LIST, undefined, authToken);
        const todoBody = await todoRes.json();
        if (todoBody.data?.getTodoList) {
          todo = todoBody.data.getTodoList.find((t: any) => t.data?.requestId === permissionRequestId);
          if (todo) break;
        }
      }

      expect(todo).toBeDefined();
      expect(todo.isRead).toBe(false);

      // Mark as read
      const markRes = await gqlRequest(MARK_TODO_READ, { todoId: todo.id }, authToken);
      const markBody = await markRes.json();
      expect(markBody.errors).toBeUndefined();
      expect(markBody.data.markTodoRead).toBe(true);

      // Verify it's marked as read
      const verifyRes = await gqlRequest(GET_TODO_LIST, undefined, authToken);
      const verifyBody = await verifyRes.json();
      const updatedTodo = verifyBody.data.getTodoList.find((t: any) => t.id === todo.id);
      expect(updatedTodo.isRead).toBe(true);

      ctrlClient.disconnect();
    });

    it('should mark all todos as read', async () => {
      const { controllerId: ctrlId, client: ctrlClient } = await createFreshController();
      const workspaceId = await createWorkspace(ctrlId);

      // Create session
      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: ctrlId, acpServerType: 'opencode', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      // Wait for acp:start and respond
      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(ctrlClient, 'acp:start', 10000);
      const startData = await startEvent;
      ctrlClient.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });

      await new Promise((r) => setTimeout(r, 500));

      // Create a permission request
      const permissionRequestId = `perm_all_${Date.now()}`;
      ctrlClient.emit('acp:permission', {
        requestId: permissionRequestId,
        sessionId,
        toolCall: { toolCallId: 'call_all' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        ],
      });

      // Wait for todo to be created
      let todoCreated = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const countRes = await gqlRequest(GET_UNREAD_TODO_COUNT, undefined, authToken);
        const countBody = await countRes.json();
        if (countBody.data?.getUnreadTodoCount > 0) {
          todoCreated = true;
          break;
        }
      }
      expect(todoCreated).toBe(true);

      // Mark all as read
      const res = await gqlRequest(MARK_ALL_TODO_READ, undefined, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.markAllTodoRead).toBe(true);

      // Verify unread count is 0
      const countRes = await gqlRequest(GET_UNREAD_TODO_COUNT, undefined, authToken);
      const countBody = await countRes.json();
      expect(countBody.data.getUnreadTodoCount).toBe(0);

      ctrlClient.disconnect();
    });
  });

  describe('Permission Timeout Settings', () => {
    it('should update global permission timeout', async () => {
      const res = await gqlRequest(
        UPDATE_GLOBAL_PERMISSION_TIMEOUT,
        { timeoutAction: 'reject' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.updateGlobalPermissionTimeout).toBe(true);
    });

    it('should update session permission timeout', async () => {
      const { controllerId: ctrlId, client: ctrlClient } = await createFreshController();
      const workspaceId = await createWorkspace(ctrlId);

      // Create session
      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId: ctrlId, acpServerType: 'opencode', workspaceId } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      // Wait for acp:start and respond
      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(ctrlClient, 'acp:start', 10000);
      const startData = await startEvent;
      ctrlClient.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });

      await new Promise((r) => setTimeout(r, 500));

      // Update session timeout
      const res = await gqlRequest(
        UPDATE_PERMISSION_TIMEOUT,
        { sessionId, timeoutAction: 'cancel' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.updatePermissionTimeout).toBe(true);

      // Verify session has the timeout action
      const verifyRes = await gqlRequest(SESSION_QUERY, { id: sessionId }, authToken);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.data.session.permissionTimeoutAction).toBe('cancel');

      ctrlClient.disconnect();
    });
  });
});
