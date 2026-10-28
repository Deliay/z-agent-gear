import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import { fundFrontUser } from './funding.js';
import { createFrontUser } from '../support/front-users.js';

// Kimi Code（Harness）登录引导 API（T-HL-API1~10）。
// 需要 agent-api + controller-api + Redis；`required/resolved` 由 fake controller 注入，
// 真实 `kimi login` 授权链路不在本套件覆盖（计划 §3 A20 / §6.4）。
const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';
const API_BASE = AGENT_API_URL.replace(/\/graphql\/?$/, '');
const HARNESS_ENABLED = process.env.HARNESS_ENABLED === 'true';
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

const LOGIN_URL = 'https://www.kimi.com/code/authorize_device?user_code=ABCD-1234';
const LOGIN_CODE = 'ABCD-1234';

let authToken = '';

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const CREATE_KEY = `
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) { key { id name } rawKey }
  }
`;

const GET_TODO_LIST = `
  query GetTodoList {
    getTodoList {
      id type priority title description isRead resolution resolvedAt expiresAt
      harnessLoginData { requestId controllerId serverType trigger url userCode expiresAt }
    }
  }
`;

const RESPOND_HARNESS_LOGIN = `
  mutation RespondHarnessLogin($requestId: String!, $action: HarnessLoginAction!) {
    respondHarnessLogin(requestId: $requestId, action: $action)
  }
`;

const CAPABILITIES = `query { cloudHostCapabilities { enabled supportedHarnesses } }`;

const CREATE_CLOUD_HOST = `
  mutation CreateCloudHost($input: CreateCloudHostInput!) {
    createCloudHost(input: $input) { id name controllerId harnessTypes status }
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

async function newFrontUser(): Promise<{ token: string; userId: string; username: string }> {
  return createFrontUser();
}

async function fundedUserToken(): Promise<string> {
  const { token, userId, username } = await newFrontUser();
  await fundFrontUser(userId, username);
  return token;
}

async function createFreshController(token: string): Promise<{ controllerId: string; client: ClientSocket }> {
  const keyRes = await gqlRequest(
    CREATE_KEY,
    { input: { name: `hl-${Date.now()}`, type: 'local' } },
    token,
  );
  const keyBody = await keyRes.json();
  const rawKey = keyBody.data.createControllerKey.rawKey as string;

  const client = createClient();
  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', {
    key: rawKey,
    hostname: 'hl-test-host',
    version: '2.8.0',
  });
  const regData = await registered;
  return { controllerId: regData.controllerId, client };
}

function emitRequired(
  client: ClientSocket,
  requestId: string,
  overrides: Record<string, unknown> = {},
): void {
  client.emit('harness:login:required', {
    requestId,
    serverType: 'kimi_code',
    trigger: 'probe-options',
    url: LOGIN_URL,
    userCode: LOGIN_CODE,
    expiresInSeconds: 1800,
    ...overrides,
  });
}

async function fetchTodos(token: string): Promise<any[]> {
  const res = await gqlRequest(GET_TODO_LIST, undefined, token);
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0].message);
  return (body.data?.getTodoList ?? []) as any[];
}

async function findTodo(requestId: string, token: string, attempts = 20): Promise<any | null> {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const todos = await fetchTodos(token);
    const todo = todos.find((t) => t.harnessLoginData?.requestId === requestId);
    if (todo) return todo;
  }
  return null;
}

async function waitForTodoResolution(
  requestId: string,
  token: string,
  attempts = 20,
): Promise<any | null> {
  for (let i = 0; i < attempts; i += 1) {
    const todo = await findTodo(requestId, token, 1);
    if (todo?.resolution) return todo;
  }
  return findTodo(requestId, token, 1);
}

interface UserStreamEvent {
  type: string;
  data?: Record<string, unknown>;
}

interface UserStream {
  next: (predicate?: (event: UserStreamEvent) => boolean, timeoutMs?: number) => Promise<UserStreamEvent>;
  close: () => void;
}

/** 用户级 SSE（?token= 鉴权）：按 `\n\n` 分帧，事件按到达顺序缓冲。 */
async function openUserStream(token: string): Promise<UserStream> {
  const controller = new AbortController();
  const res = await fetch(
    `${API_BASE}/api/user/stream?token=${encodeURIComponent(token)}`,
    { signal: controller.signal, headers: { Accept: 'text/event-stream' } },
  );
  if (!res.ok || !res.body) throw new Error(`SSE failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const buffered: UserStreamEvent[] = [];
  const waiters: Array<{
    predicate: (event: UserStreamEvent) => boolean;
    resolve: (event: UserStreamEvent) => void;
  }> = [];
  let closed = false;
  let buffer = '';

  const push = (event: UserStreamEvent) => {
    const index = waiters.findIndex((waiter) => waiter.predicate(event));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter!.resolve(event);
      return;
    }
    buffered.push(event);
  };

  void (async () => {
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
          if (data) {
            try {
              push(JSON.parse(data) as UserStreamEvent);
            } catch {
              /* 心跳/注释帧忽略 */
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* 关闭时 abort 属预期 */
    }
  })();

  return {
    next(predicate = () => true, timeoutMs = 10000) {
      const index = buffered.findIndex(predicate);
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]!);
      return new Promise<UserStreamEvent>((resolve, reject) => {
        const waiter = {
          predicate,
          resolve: (event: UserStreamEvent) => {
            clearTimeout(timer);
            resolve(event);
          },
        };
        const timer = setTimeout(() => {
          const position = waiters.indexOf(waiter);
          if (position >= 0) waiters.splice(position, 1);
          reject(new Error('Timeout waiting for user SSE event'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close() {
      closed = true;
      controller.abort();
    },
  };
}

beforeAll(async () => {
  authToken = (await newFrontUser()).token;
});

describe('Harness Login API', () => {
  it('T-HL-API7: respondHarnessLogin without auth returns Not authenticated', async () => {
    const res = await gqlRequest(RESPOND_HARNESS_LOGIN, {
      requestId: 'hl-noauth',
      action: 'cancel',
    });
    const body = await res.json();
    expect(body.errors?.[0].message).toBe('Not authenticated');
  });

  it('T-HL-API1: required creates an immediate unread todo with verbatim link/code', async () => {
    const { client } = await createFreshController(authToken);
    const requestId = `hl_req_${Date.now()}`;
    try {
      emitRequired(client, requestId);
      const todo = await findTodo(requestId, authToken);
      expect(todo).toBeTruthy();
      expect(todo.type).toBe('harness_login_request');
      expect(todo.priority).toBe('immediate');
      expect(todo.title).toBe('Kimi Code 需要登录');
      expect(todo.isRead).toBe(false);
      expect(todo.resolution).toBeNull();
      expect(todo.harnessLoginData).toMatchObject({
        requestId,
        serverType: 'kimi_code',
        trigger: 'probe-options',
        url: LOGIN_URL,
        userCode: LOGIN_CODE,
      });
      // expiresAt ≈ 30 分钟后（与设备码有效期一致）；顶层 expiresAt 为同一值
      const remaining = new Date(todo.expiresAt).getTime() - Date.now();
      expect(remaining).toBeGreaterThan(25 * 60_000);
      expect(remaining).toBeLessThanOrEqual(31 * 60_000);
    } finally {
      client.disconnect();
    }
  });

  it('T-HL-API2: succeeded collapses the todo to accepted without a second todo', async () => {
    const { client } = await createFreshController(authToken);
    const requestId = `hl_ok_${Date.now()}`;
    try {
      emitRequired(client, requestId, { trigger: 'acp:start' });
      const created = await findTodo(requestId, authToken);
      expect(created).toBeTruthy();

      client.emit('harness:login:succeeded', { requestId, account: 'managed:kimi-code' });
      const resolved = await waitForTodoResolution(requestId, authToken);
      expect(resolved.resolution).toBe('accepted');
      expect(resolved.isRead).toBe(true);
      expect(resolved.resolvedAt).toBeTruthy();

      const todos = (await fetchTodos(authToken)).filter(
        (todo) => todo.harnessLoginData?.requestId === requestId,
      );
      expect(todos).toHaveLength(1);
    } finally {
      client.disconnect();
    }
  });

  it('T-HL-API3: cancel publishes to the controller and collapses to cancelled', async () => {
    const { client } = await createFreshController(authToken);
    const requestId = `hl_cancel_${Date.now()}`;
    try {
      emitRequired(client, requestId, { trigger: 'acp:resume' });
      await findTodo(requestId, authToken);

      const cancelEvent = waitForEvent<{ requestId: string }>(
        client,
        'harness:login:cancel',
        10000,
      );
      const res = await gqlRequest(
        RESPOND_HARNESS_LOGIN,
        { requestId, action: 'cancel' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.respondHarnessLogin).toBe(true);
      await expect(cancelEvent).resolves.toMatchObject({ requestId });

      // controller 终止进程后回报 failed(cancelled)
      client.emit('harness:login:failed', { requestId, reason: 'cancelled' });
      const resolved = await waitForTodoResolution(requestId, authToken);
      expect(resolved.resolution).toBe('cancelled');
      expect(resolved.isRead).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  it('T-HL-API4: duplicate required on the same controller yields a single todo', async () => {
    const { client } = await createFreshController(authToken);
    const firstId = `hl_dup_a_${Date.now()}`;
    const secondId = `hl_dup_b_${Date.now()}`;
    try {
      emitRequired(client, firstId);
      await findTodo(firstId, authToken);
      emitRequired(client, secondId);
      await new Promise((r) => setTimeout(r, 1500));

      const todos = (await fetchTodos(authToken)).filter((todo) =>
        [firstId, secondId].includes(todo.harnessLoginData?.requestId),
      );
      expect(todos).toHaveLength(1);
      expect(todos[0].harnessLoginData.requestId).toBe(firstId);
    } finally {
      client.disconnect();
    }
  });

  it('T-HL-API5: failed(timeout) expires the todo and a new trigger opens a new one', async () => {
    const { client } = await createFreshController(authToken);
    const firstId = `hl_to_${Date.now()}`;
    const secondId = `hl_to_retry_${Date.now()}`;
    try {
      emitRequired(client, firstId);
      await findTodo(firstId, authToken);
      client.emit('harness:login:failed', { requestId: firstId, reason: 'timeout' });

      const expired = await waitForTodoResolution(firstId, authToken);
      expect(expired.resolution).toBe('expired');
      expect(expired.isRead).toBe(true);

      // 注册表已清除：再次触发可新建待办
      emitRequired(client, secondId);
      const retry = await findTodo(secondId, authToken);
      expect(retry).toBeTruthy();
      expect(retry?.resolution).toBeNull();
    } finally {
      client.disconnect();
    }
  });

  it('T-HL-API6: another user cannot cancel; the owner can', async () => {
    const { client } = await createFreshController(authToken);
    const other = await newFrontUser();
    const requestId = `hl_owner_${Date.now()}`;
    try {
      emitRequired(client, requestId);
      await findTodo(requestId, authToken);

      const foreign = await gqlRequest(
        RESPOND_HARNESS_LOGIN,
        { requestId, action: 'cancel' },
        other.token,
      );
      const foreignBody = await foreign.json();
      expect(foreignBody.errors?.[0].message).toBe('Todo item not found or already handled');

      // 他人失败后待办仍待处理（未被跨租户收敛）
      const stillPending = await findTodo(requestId, authToken);
      expect(stillPending?.resolution).toBeNull();

      const own = await gqlRequest(
        RESPOND_HARNESS_LOGIN,
        { requestId, action: 'cancel' },
        authToken,
      );
      const ownBody = await own.json();
      expect(ownBody.errors).toBeUndefined();
      expect(ownBody.data.respondHarnessLogin).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  it('T-HL-API8: user-level SSE delivers ready / required / resolved', async () => {
    const stream = await openUserStream(authToken);
    const { client } = await createFreshController(authToken);
    const requestId = `hl_sse_${Date.now()}`;
    try {
      await expect(stream.next((event) => event.type === 'ready')).resolves.toMatchObject({
        type: 'ready',
      });

      emitRequired(client, requestId, { trigger: 'acp:start' });
      const required = await stream.next(
        (event) =>
          event.type === 'harness_login_required' &&
          event.data?.requestId === requestId,
      );
      expect(required.data).toMatchObject({
        requestId,
        serverType: 'kimi_code',
        trigger: 'acp:start',
        url: LOGIN_URL,
        userCode: LOGIN_CODE,
      });
      expect(required.data?.expiresAt).toBeTruthy();
      expect(required.data?.todoId).toBeTruthy();

      client.emit('harness:login:succeeded', { requestId });
      const resolved = await stream.next(
        (event) =>
          event.type === 'harness_login_resolved' &&
          event.data?.requestId === requestId,
      );
      expect(resolved.data?.result).toBe('succeeded');
    } finally {
      stream.close();
      client.disconnect();
    }
  });
});

const STOP_CLOUD_HOST = `
  mutation Stop($id: ID!, $force: Boolean) {
    stopCloudHost(id: $id, force: $force) { id status }
  }
`;
const DELETE_CLOUD_HOST = `mutation Delete($id: ID!) { deleteCloudHost(id: $id) }`;

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

describe.skipIf(!HARNESS_ENABLED)('Harness Login API: capabilities', () => {
  it('T-HL-API10: supportedHarnesses lists KIMI_CODE when its preset exists', async () => {
    const token = (await newFrontUser()).token;
    const result = await gqlRequest(CAPABILITIES, undefined, token);
    const body = await result.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.cloudHostCapabilities.enabled).toBe(true);
    expect(body.data.cloudHostCapabilities.supportedHarnesses).toContain('OPENCODE');
    if (HAS_MONGO) {
      const preset = await (await mongoDb())!.collection('cloudworkloads').findOne({
        presetKey: 'harness-kimi-code',
      });
      expect(preset, 'migration 009 should seed harness-kimi-code').toBeTruthy();
      expect(body.data.cloudHostCapabilities.supportedHarnesses).toContain('KIMI_CODE');
    }
  });
});

describe.skipIf(!HARNESS_ENABLED || !HAS_MONGO)('Harness Login API: version gate', () => {
  it('T-HL-API9: KIMI_CODE host persists agentGearMinVersion=2.10.0', async () => {
    const db = (await mongoDb())!;
    const token = await fundedUserToken();
    const name = `hl-kimi-${Date.now().toString(36)}`;
    const created = await gqlRequest(
      CREATE_CLOUD_HOST,
      { input: { name, harnessTypes: ['KIMI_CODE'] } },
      token,
    );
    const body = await created.json();
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
    const host = body.data.createCloudHost as {
      id: string;
      controllerId: string;
      harnessTypes: string[];
    };

    try {
      expect(host.harnessTypes).toEqual(['KIMI_CODE']);
      let doc: any = null;
      for (let i = 0; i < 20; i += 1) {
        doc = await db.collection('cloudcontainers').findOne({ hostId: host.id });
        if (doc) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(doc, 'cloud-controller should persist the container').toBeTruthy();
      expect(doc.harnessTypes).toEqual(['kimi_code']);
      expect(doc.agentGearMinVersion).toBe('2.10.0');
    } finally {
      await gqlRequest(STOP_CLOUD_HOST, { id: host.id, force: true }, token);
      await gqlRequest(DELETE_CLOUD_HOST, { id: host.id }, token);
    }
  });
});
