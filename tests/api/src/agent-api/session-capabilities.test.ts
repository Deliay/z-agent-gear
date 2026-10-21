import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import mongoose from 'mongoose';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';
const MONGODB_URI = process.env.MONGODB_URI || '';

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return fetch(AGENT_API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
}

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) { token user { id username } }
  }
`;
const CREATE_KEY = `
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) { rawKey key { id } }
  }
`;
const CREATE_WORKSPACE = `
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) { id controllerId path }
  }
`;
const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) { session { id status } }
  }
`;
const CLOSE_SESSION = `
  mutation CloseSession($id: ID!) { closeSession(id: $id) }
`;
const RESUME_SESSION = `
  mutation ResumeSession($id: ID!) { resumeSession(id: $id) { success status error } }
`;
const GET_SESSION = `
  query GetSession($id: ID!) {
    session(id: $id) {
      id
      status
      agentCapabilities {
        protocolVersion
        agentInfo { name version }
        features { id status detail }
      }
      features { id status detail }
    }
  }
`;
const GET_TODO_LIST = `
  query GetTodoList {
    getTodoList {
      id
      type
      resolution
      resolvedAt
      expiresAt
      elicitationData { requestId sessionId mode message }
    }
  }
`;
const RESPOND_ELICITATION = `
  mutation RespondElicitation($requestId: String!, $action: ElicitationAction!, $values: JSON) {
    respondElicitation(requestId: $requestId, action: $action, values: $values)
  }
`;

const FEATURE_IDS = [
  'session.load', 'session.resume', 'session.close', 'session.list', 'session.delete',
  'session.fork', 'session.additionalDirectories',
  'prompt.image', 'prompt.audio', 'prompt.embeddedContext',
  'auth.login', 'auth.logout', 'mcp.http', 'mcp.sse',
  'config.boolean', 'config.model', 'config.mode', 'commands',
  'elicitation.form', 'elicitation.url',
];

function makeCapabilities(agentVersion = '2.0.31') {
  return {
    protocolVersion: 1,
    agentInfo: { name: 'OpenCode', version: agentVersion },
    features: FEATURE_IDS.map((id) => ({
      id,
      status: id === 'prompt.audio' ? 'unsupported' : id === 'prompt.image' ? 'partial' : 'supported',
      detail: id === 'prompt.audio' ? '未声明 agentCapabilities.promptCapabilities.audio' : null,
    })),
    raw: {
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      authMethods: [],
      clientCapabilities: { elicitation: { form: {}, url: {} } },
    },
  };
}

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

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let authToken = '';
let mongoConnection: typeof mongoose | null = null;

async function createFreshController(): Promise<{ controllerId: string; client: ClientSocket }> {
  const keyRes = await gqlRequest(
    CREATE_KEY,
    { input: { name: `cap-${Date.now()}`, type: 'local' } },
    authToken,
  );
  const keyBody = await keyRes.json();
  const rawKey = keyBody.data.createControllerKey.rawKey;

  const client = createClient();
  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', { key: rawKey, hostname: 'cap-test-host', version: '2.0.0' });
  const regData = await registered;
  return { controllerId: regData.controllerId, client };
}

async function createWorkspace(ctrlId: string): Promise<string> {
  const res = await gqlRequest(
    CREATE_WORKSPACE,
    { input: { controllerId: ctrlId, path: `/tmp/cap-test-${Date.now()}` } },
    authToken,
  );
  const body = await res.json();
  return body.data.createWorkspace.id;
}

async function createSession(
  ctrlClient: ClientSocket,
  ctrlId: string,
  resultExtra: Record<string, unknown>,
): Promise<string> {
  const workspaceId = await createWorkspace(ctrlId);
  const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(ctrlClient, 'acp:start', 15000);
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
    ...resultExtra,
  });
  await sleep(500);
  return sessionId;
}

async function getSession(sessionId: string): Promise<any> {
  const res = await gqlRequest(GET_SESSION, { id: sessionId }, authToken);
  const body = await res.json();
  return body.data?.session;
}

async function findTodo(requestId: string): Promise<any> {
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const res = await gqlRequest(GET_TODO_LIST, undefined, authToken);
    const body = await res.json();
    const todo = body.data?.getTodoList?.find(
      (item: any) => item.elicitationData?.requestId === requestId,
    );
    if (todo) return todo;
  }
  return null;
}

describe('ACP 会话能力快照 API', () => {
  beforeAll(async () => {
    const uid = `cap_${Date.now().toString(36)}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token ?? '';
    expect(authToken).toBeTruthy();
  });

  afterAll(async () => {
    if (mongoConnection) await mongoConnection.disconnect();
  });

  it('T-AC1: fake controller 上报 capabilities → GraphQL 返回快照与 features', async () => {
    const { controllerId, client } = await createFreshController();
    const sessionId = await createSession(client, controllerId, { capabilities: makeCapabilities() });

    const session = await getSession(sessionId);
    expect(session.agentCapabilities.protocolVersion).toBe(1);
    expect(session.agentCapabilities.agentInfo).toEqual({ name: 'OpenCode', version: '2.0.31' });
    expect(session.features).toHaveLength(FEATURE_IDS.length);
    expect(session.features.map((f: { id: string }) => f.id)).toEqual(FEATURE_IDS);

    client.disconnect();
  });

  it('T-AC2: resume 上报新快照后 agentInfo/features 更新（不残留旧值）', async () => {
    const { controllerId, client } = await createFreshController();
    const sessionId = await createSession(client, controllerId, { capabilities: makeCapabilities('2.0.31') });

    await gqlRequest(CLOSE_SESSION, { id: sessionId }, authToken);
    await sleep(300);

    const resumeEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:resume', 15000);
    const resumeRes = await gqlRequest(RESUME_SESSION, { id: sessionId }, authToken);
    const resumeBody = await resumeRes.json();
    expect(resumeBody.data?.resumeSession?.success).toBe(true);

    const resumeData = await resumeEvent;
    client.emit('acp:resume:result', {
      requestId: resumeData.requestId,
      sessionId,
      success: true,
      capabilities: makeCapabilities('2.1.0'),
    });
    await sleep(700);

    const session = await getSession(sessionId);
    expect(session.agentCapabilities.agentInfo.version).toBe('2.1.0');
    expect(session.features).toHaveLength(FEATURE_IDS.length);

    client.disconnect();
  });

  it('T-AC3: 旧 controller（不带 capabilities）→ agentCapabilities=null、features=[]', async () => {
    const { controllerId, client } = await createFreshController();
    const sessionId = await createSession(client, controllerId, {});

    const session = await getSession(sessionId);
    expect(session.agentCapabilities).toBeNull();
    expect(session.features).toEqual([]);
    expect(session.status).toBe('idling');

    client.disconnect();
  });

  it('T-AC4: features 内容抽样', async () => {
    const { controllerId, client } = await createFreshController();
    const sessionId = await createSession(client, controllerId, { capabilities: makeCapabilities() });

    const session = await getSession(sessionId);
    const byId = new Map<string, any>(session.features.map((f: any) => [f.id, f]));
    expect(byId.get('session.load')?.status).toBe('supported');
    expect(byId.get('prompt.audio')?.status).toBe('unsupported');
    expect(byId.get('elicitation.form')?.status).toBe('supported');

    client.disconnect();
  });

  it('T-AC6: acp:elicitation:resolved(timeout) → 待办 resolution=expired', async () => {
    const { controllerId, client } = await createFreshController();
    const sessionId = await createSession(client, controllerId, { capabilities: makeCapabilities() });

    const requestId = `cap_elic_${Date.now()}`;
    client.emit('acp:elicitation', {
      requestId,
      sessionId,
      mode: 'form',
      message: 'Need input',
      requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } },
    });

    const created = await findTodo(requestId);
    expect(created).toBeDefined();
    expect(created.resolution).toBeNull();

    client.emit('acp:elicitation:resolved', {
      requestId,
      sessionId,
      reason: 'timeout',
      detail: 'test timeout',
    });

    let updated: any = null;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      updated = await findTodo(requestId);
      if (updated?.resolution) break;
    }
    expect(updated?.resolution).toBe('expired');
    expect(updated?.resolvedAt).toBeTruthy();

    client.disconnect();
  });

  it('T-AC7: respondElicitation(decline) → todo resolution=declined，controller 收到 decline', async () => {
    const { controllerId, client } = await createFreshController();
    const sessionId = await createSession(client, controllerId, { capabilities: makeCapabilities() });

    const requestId = `cap_decline_${Date.now()}`;
    const responseEvent = waitForEvent<{ requestId: string; action: string }>(
      client,
      'acp:elicitation:response',
    );

    client.emit('acp:elicitation', {
      requestId,
      sessionId,
      mode: 'form',
      message: 'Need input',
      requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } },
    });
    await findTodo(requestId);

    const res = await gqlRequest(
      RESPOND_ELICITATION,
      { requestId, action: 'decline' },
      authToken,
    );
    const body = await res.json();
    expect(body.data.respondElicitation).toBe(true);

    const response = await responseEvent;
    expect(response.action).toBe('decline');

    let updated: any = null;
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      updated = await findTodo(requestId);
      if (updated?.resolution) break;
    }
    expect(updated?.resolution).toBe('declined');

    client.disconnect();
  });

  describe.skipIf(!MONGODB_URI)('T-AC5: 模型来源三档分组（需 MONGODB_URI）', () => {
    it('平台内置/自定义/Agent 自带/来源未知四组', async () => {
      mongoConnection = await mongoose.connect(MONGODB_URI);
      const suffix = Date.now().toString(36);
      const globalName = `cap-gpt-4o-${suffix}`;
      const userName = `cap-my-model-${suffix}`;
      const providerId = new mongoose.Types.ObjectId();
      const collection = mongoConnection.connection.collection('models');
      await collection.insertMany([
        {
          providerId, name: globalName, scope: 'global', isEnabled: true,
          isCustom: false, sortOrder: 0, createdAt: new Date(), updatedAt: new Date(),
        },
        {
          providerId, name: userName, scope: 'user', isEnabled: true,
          isCustom: true, sortOrder: 0, createdAt: new Date(), updatedAt: new Date(),
        },
      ]);

      try {
        const { controllerId, client } = await createFreshController();
        const sessionId = await createSession(client, controllerId, {
          capabilities: makeCapabilities(),
          availableModels: [
            { id: globalName, name: globalName },
            { id: userName, name: userName },
            { id: 'opencode-go/kimi-k3', name: 'Kimi K3' },
            { id: `cap-local-llm-${suffix}`, name: 'Local LLM' },
          ],
          currentModelId: globalName,
        });

        const res = await gqlRequest(
          `query GetSession($id: ID!) {
            session(id: $id) {
              availableModels { id name source sourceProvider group basis }
            }
          }`,
          { id: sessionId },
          authToken,
        );
        const body = await res.json();
        const models = body.data.session.availableModels as Array<Record<string, unknown>>;
        expect(models.map((m) => m.group)).toEqual([
          '平台内置', '自定义', 'Agent 自带', '来源未知',
        ]);
        expect(models.map((m) => m.basis)).toEqual([
          '按平台模型库比对（平台内置）',
          '按平台模型库比对（自定义）',
          '按标识前缀判定（opencode-go）',
          '无法判定',
        ]);

        client.disconnect();
      } finally {
        await collection.deleteMany({ name: { $in: [globalName, userName] } });
      }
    });
  });
});
