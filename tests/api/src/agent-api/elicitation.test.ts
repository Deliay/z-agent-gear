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
        toolCallId
        toolCall {
          toolCallId
          title
        }
      }
      elicitationData {
        requestId
        sessionId
        toolCallId
        mode
        message
        requestedSchema
        elicitationId
        url
      }
      createdAt
    }
  }
`;

const RESPOND_ELICITATION = `
  mutation RespondElicitation($requestId: String!, $action: ElicitationAction!, $values: JSON) {
    respondElicitation(requestId: $requestId, action: $action, values: $values)
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

async function createFreshController(): Promise<{ controllerId: string; client: ClientSocket }> {
  const keyRes = await gqlRequest(
    CREATE_KEY,
    { input: { name: `elic-${Date.now()}`, type: 'local' } },
    authToken,
  );
  const keyBody = await keyRes.json();
  const rawKey = keyBody.data.createControllerKey.rawKey;

  const client = createClient();
  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', { key: rawKey, hostname: 'elic-test-host', version: '2.0.0' });
  const regData = await registered;

  return { controllerId: regData.controllerId, client };
}

async function createWorkspace(ctrlId: string): Promise<string> {
  const res = await gqlRequest(
    CREATE_WORKSPACE,
    { input: { controllerId: ctrlId, path: `/tmp/elic-test-${Date.now()}` } },
    authToken,
  );
  const body = await res.json();
  return body.data.createWorkspace.id;
}

async function createRunningSession(ctrlClient: ClientSocket, ctrlId: string): Promise<string> {
  const workspaceId = await createWorkspace(ctrlId);

  // Register acp:start listener before creating session to avoid race
  const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(ctrlClient, 'acp:start', 10000);
  const sessionRes = await gqlRequest(
    CREATE_SESSION,
    { input: { controllerId: ctrlId, acpServerType: 'opencode', workspaceId } },
    authToken,
  );
  const sessionBody = await sessionRes.json();
  const sessionId = sessionBody.data.createSession.session.id;

  const startData = await startEvent;
  ctrlClient.emit('acp:start:result', {
    requestId: startData.requestId,
    sessionId,
    success: true,
    externalSessionId: `ext_${Date.now()}`,
  });

  await new Promise((r) => setTimeout(r, 500));
  return sessionId;
}

async function findTodoByRequestId(requestId: string): Promise<any> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const todoRes = await gqlRequest(GET_TODO_LIST, undefined, authToken);
    const todoBody = await todoRes.json();
    if (todoBody.data?.getTodoList) {
      const todo = todoBody.data.getTodoList.find(
        (t: any) => t.elicitationData?.requestId === requestId,
      );
      if (todo) return todo;
    }
  }
  return null;
}

const FORM_SCHEMA = {
  type: 'object',
  title: '重构策略',
  properties: {
    strategy: { type: 'string', enum: ['conservative', 'balanced', 'aggressive'] },
    dryRun: { type: 'boolean', default: true },
  },
  required: ['strategy'],
};

describe('ACP Elicitation API', () => {
  beforeAll(async () => {
    const frontUser = await createFrontUser();
    authToken = frontUser.token;
    expect(authToken).toBeTruthy();
  });

  describe('Auth', () => {
    it('should reject respondElicitation without auth', async () => {
      const res = await gqlRequest(RESPOND_ELICITATION, {
        requestId: 'elic-noauth',
        action: 'accept',
        values: { strategy: 'balanced' },
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('Form Mode', () => {
    it('should create elicitation todo when controller sends acp:elicitation (form)', async () => {
      const { controllerId: ctrlId, client: ctrlClient } = await createFreshController();
      const sessionId = await createRunningSession(ctrlClient, ctrlId);

      const requestId = `elic_form_${Date.now()}`;
      ctrlClient.emit('acp:elicitation', {
        requestId,
        sessionId,
        mode: 'form',
        message: 'How should I approach this refactoring?',
        requestedSchema: FORM_SCHEMA,
      });

      const todo = await findTodoByRequestId(requestId);
      expect(todo).toBeDefined();
      expect(todo.type).toBe('elicitation_request');
      // 混合列表：信息请求待办的权限数据必须为 null（Mongoose 空子文档归一化）
      expect(todo.data).toBeNull();
      expect(todo.priority).toBe('immediate');
      expect(todo.title).toBe('Agent请求输入：重构策略');
      expect(todo.description).toBe('How should I approach this refactoring?');
      expect(todo.isRead).toBe(false);
      expect(todo.elicitationData.mode).toBe('form');
      expect(todo.elicitationData.message).toBe('How should I approach this refactoring?');
      expect(todo.elicitationData.requestedSchema.required).toEqual(['strategy']);

      ctrlClient.disconnect();
    });

    it('should relay accept response with content back to controller', async () => {
      const { controllerId: ctrlId, client: ctrlClient } = await createFreshController();
      const sessionId = await createRunningSession(ctrlClient, ctrlId);

      const requestId = `elic_accept_${Date.now()}`;
      const responseEvent = waitForEvent<{ requestId: string; action: string; content?: any }>(
        ctrlClient,
        'acp:elicitation:response',
        10000,
      );

      ctrlClient.emit('acp:elicitation', {
        requestId,
        sessionId,
        mode: 'form',
        message: 'How should I approach this refactoring?',
        requestedSchema: FORM_SCHEMA,
      });

      await findTodoByRequestId(requestId);

      const respondRes = await gqlRequest(
        RESPOND_ELICITATION,
        { requestId, action: 'accept', values: { strategy: 'balanced', dryRun: true } },
        authToken,
      );
      const respondBody = await respondRes.json();
      expect(respondBody.errors).toBeUndefined();
      expect(respondBody.data.respondElicitation).toBe(true);

      const response = await responseEvent;
      expect(response.requestId).toBe(requestId);
      expect(response.action).toBe('accept');
      expect(response.content).toEqual({ strategy: 'balanced', dryRun: true });

      // Todo should be marked as read after responding
      const todo = await findTodoByRequestId(requestId);
      expect(todo.isRead).toBe(true);

      ctrlClient.disconnect();
    });

    it('should relay decline response without content back to controller', async () => {
      const { controllerId: ctrlId, client: ctrlClient } = await createFreshController();
      const sessionId = await createRunningSession(ctrlClient, ctrlId);

      const requestId = `elic_decline_${Date.now()}`;
      const responseEvent = waitForEvent<{ requestId: string; action: string; content?: any }>(
        ctrlClient,
        'acp:elicitation:response',
        10000,
      );

      ctrlClient.emit('acp:elicitation', {
        requestId,
        sessionId,
        mode: 'form',
        message: 'How should I approach this refactoring?',
        requestedSchema: FORM_SCHEMA,
      });

      await findTodoByRequestId(requestId);

      const respondRes = await gqlRequest(
        RESPOND_ELICITATION,
        { requestId, action: 'decline', values: { strategy: 'ignored' } },
        authToken,
      );
      const respondBody = await respondRes.json();
      expect(respondBody.errors).toBeUndefined();

      const response = await responseEvent;
      expect(response.requestId).toBe(requestId);
      expect(response.action).toBe('decline');
      expect(response.content).toBeUndefined();

      ctrlClient.disconnect();
    });
  });

  describe('URL Mode', () => {
    it('should create elicitation todo with url and mark it completed on acp:elicitation:complete', async () => {
      const { controllerId: ctrlId, client: ctrlClient } = await createFreshController();
      const sessionId = await createRunningSession(ctrlClient, ctrlId);

      const requestId = `elic_url_${Date.now()}`;
      const elicitationId = `oauth_${Date.now()}`;
      ctrlClient.emit('acp:elicitation', {
        requestId,
        sessionId,
        mode: 'url',
        message: 'Please authorize access to your repositories.',
        elicitationId,
        url: `https://agent.example.com/connect?elicitationId=${elicitationId}`,
      });

      const todo = await findTodoByRequestId(requestId);
      expect(todo).toBeDefined();
      expect(todo.type).toBe('elicitation_request');
      expect(todo.title).toBe('Agent请求输入：打开链接授权');
      expect(todo.elicitationData.mode).toBe('url');
      expect(todo.elicitationData.elicitationId).toBe(elicitationId);
      expect(todo.elicitationData.url).toContain(elicitationId);
      expect(todo.isRead).toBe(false);

      // Agent notifies completion of the out-of-band interaction
      ctrlClient.emit('acp:elicitation:complete', { sessionId, elicitationId });

      // Todo should be marked as read (poll)
      let completed = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const updated = await findTodoByRequestId(requestId);
        if (updated?.isRead) {
          completed = true;
          break;
        }
      }
      expect(completed).toBe(true);

      ctrlClient.disconnect();
    });

    it('should relay url-mode accept (consent to open) back to controller', async () => {
      const { controllerId: ctrlId, client: ctrlClient } = await createFreshController();
      const sessionId = await createRunningSession(ctrlClient, ctrlId);

      const requestId = `elic_url_accept_${Date.now()}`;
      const elicitationId = `oauth_accept_${Date.now()}`;
      const responseEvent = waitForEvent<{ requestId: string; action: string }>(
        ctrlClient,
        'acp:elicitation:response',
        10000,
      );

      ctrlClient.emit('acp:elicitation', {
        requestId,
        sessionId,
        mode: 'url',
        message: 'Please authorize access to your repositories.',
        elicitationId,
        url: `https://agent.example.com/connect?elicitationId=${elicitationId}`,
      });

      await findTodoByRequestId(requestId);

      const respondRes = await gqlRequest(
        RESPOND_ELICITATION,
        { requestId, action: 'accept' },
        authToken,
      );
      const respondBody = await respondRes.json();
      expect(respondBody.errors).toBeUndefined();

      const response = await responseEvent;
      expect(response.requestId).toBe(requestId);
      expect(response.action).toBe('accept');

      ctrlClient.disconnect();
    });
  });
});
