import { describe, it, expect, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { io as SocketIOClient, type Socket } from 'socket.io-client';
import { createFrontUser } from '../support/front-users.js';
import { personalGlobalWorkspaceId } from '../support/workspace-fixtures.js';

/**
 * 会话归档 / 工作区删除连带归档（Phase 9，计划 §4.2）：
 *
 * - T-ARCH-API1 `archiveSession` 未认证拒绝；
 * - T-ARCH-API2 归档/取消归档成功，DB `archivedAt` 往返（幂等）；
 * - T-ARCH-API3 工作流节点会话拒绝 `ARCHIVE_WORKFLOW_SESSION_UNSUPPORTED`；
 *   `sessions(archived)` 三档列表口径（默认=活跃 / false=活跃 / true=已归档，与 includeWorkflowSessions 正交）；
 * - T-ARCH-API4 `homeOverview.archivedSessions` 与活跃 `sessions` 互补、`sessionTotalCount` 为未归档计数；
 * - T-WSARC-API1 `deleteWorkspace` 连带：DB 断言 `archivedAt` 非空、活跃会话 `status=ended`、工作区行删除；
 * - T-WSARC-API2 `workspaceArchiveImpact.sessionCount` = 实际连带归档数量（且不含其它工作区会话）。
 *
 * 每条用例独立开户（`createFrontUser`），home/sessions 计数断言不受同套件其它用例污染。
 * 需要 agent-api + controller-api 就绪、`INTERNAL_API_TOKEN`（开户）与 `MONGODB_URI`（DB 断言，缺省整套 skip）。
 */
const GRAPHQL_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

function gql(
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
): Promise<{ data?: any; errors?: Array<{ message: string }> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(GRAPHQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  }).then((res) => res.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>);
}

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

// ---------------------------------------------------------------------------
// GraphQL 文档
// ---------------------------------------------------------------------------

const ARCHIVE_SESSION = `
  mutation Archive($id: ID!, $archived: Boolean!) {
    archiveSession(id: $id, archived: $archived)
  }
`;

const WORKSPACE_ARCHIVE_IMPACT = `
  mutation Impact($id: ID!) {
    workspaceArchiveImpact(id: $id) { sessionCount }
  }
`;

const DELETE_WORKSPACE = `
  mutation Delete($id: ID!) { deleteWorkspace(id: $id) }
`;

const CREATE_KEY = `
  mutation CreateKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) { rawKey }
  }
`;

const CREATE_WORKSPACE = `
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) { id path }
  }
`;

const CREATE_SESSION = `
  mutation Create($input: CreateSessionInput!) {
    createSession(input: $input) { session { id status } }
  }
`;

const SESSIONS = `
  query Sessions($archived: Boolean, $includeWorkflowSessions: Boolean) {
    sessions(archived: $archived, includeWorkflowSessions: $includeWorkflowSessions) {
      id
      archived
      workflowInstanceId
    }
  }
`;

const SESSION = `
  query Session($id: ID!) {
    session(id: $id) { id archived readOnlyReason }
  }
`;

const HOME_OVERVIEW = `
  query HomeOverview {
    homeOverview {
      sessions { id archived }
      sessionTotalCount
      archivedSessions { id archived }
    }
  }
`;

// ---------------------------------------------------------------------------
// Fake controller（应答 acp:check / acp:start / git:worktree:list）
// ---------------------------------------------------------------------------

interface FakeController {
  controllerId: string;
  disconnect: () => void;
}

function registerFakeController(rawKey: string, hostname: string): Promise<FakeController> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error('Timeout registering controller'));
    }, 10000);

    client.on('acp:check', (data: { requestId: string }) => {
      client.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      });
    });

    client.on('git:worktree:list', (data: { requestId: string }) => {
      client.emit('git:worktree:list:result', {
        requestId: data.requestId,
        success: true,
        worktrees: [],
      });
    });

    client.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      client.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_${data.sessionId}`,
      });
    });

    // 连带归档会 close 活跃会话（acp:stop 无 ack 等待，这里仅保持 controller-api 侧状态干净）
    client.on('acp:stop', (data: { sessionId: string; ackRequired?: boolean }) => {
      if (data.ackRequired) {
        client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'workspace_deleted', killed: true });
      }
    });

    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve({ controllerId: data.controllerId, disconnect: () => client.disconnect() });
    });
    client.once('error', (data: { message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Register failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname, version: '2.0.0' });
  });
}

// ---------------------------------------------------------------------------
// 夹具：每条用例独立用户 + 控制器 + 项目工作区
// ---------------------------------------------------------------------------

interface Fixture {
  token: string;
  userId: string;
  controllerId: string;
  createWorkspace: (path: string) => Promise<string>;
  createSession: (workspaceId: string) => Promise<{ id: string; status: string }>;
}

const registered: Array<{ controllerId: mongoose.Types.ObjectId; socket: FakeController }> = [];

async function createFixture(tag: string): Promise<Fixture> {
  const user = await createFrontUser();
  const keyRes = await gql(CREATE_KEY, { input: { name: `arch-${tag}`, type: 'local' } }, user.token);
  if (keyRes.errors) throw new Error(JSON.stringify(keyRes.errors));
  const socket = await registerFakeController(keyRes.data.createControllerKey.rawKey, `arch-${tag}-host`);
  const controllerId = new mongoose.Types.ObjectId(socket.controllerId);
  registered.push({ controllerId, socket });

  return {
    token: user.token,
    userId: user.userId,
    controllerId: socket.controllerId,
    createWorkspace: async (path: string) => {
      const res = await gql(CREATE_WORKSPACE, { input: { controllerId: socket.controllerId, path } }, user.token);
      if (res.errors) throw new Error(JSON.stringify(res.errors));
      return res.data.createWorkspace.id as string;
    },
    createSession: async (workspaceId: string) => {
      const res = await gql(
        CREATE_SESSION,
        { input: { controllerId: socket.controllerId, acpServerType: 'opencode', workspaceId } },
        user.token,
      );
      if (res.errors) throw new Error(JSON.stringify(res.errors));
      return res.data.createSession.session as { id: string; status: string };
    },
  };
}

/** 直插一条工作流节点会话（GraphQL CreateSessionInput 不暴露 workflowInstanceId）。 */
async function insertWorkflowSession(fixture: Fixture): Promise<mongoose.Types.ObjectId> {
  const db = (await mongoDb())!;
  const now = new Date();
  const inserted = await db.collection('sessions').insertOne({
    userId: new mongoose.Types.ObjectId(fixture.userId),
    tenantId: new mongoose.Types.ObjectId(fixture.userId),
    workspaceId: await personalGlobalWorkspaceId(db, fixture.userId),
    controllerId: new mongoose.Types.ObjectId(fixture.controllerId),
    controllerName: 'arch-fixture',
    acpServerType: 'opencode',
    status: 'ended',
    title: 'workflow-node-session',
    workflowInstanceId: new mongoose.Types.ObjectId(),
    workflowNodeId: 'node-1',
    archivedAt: null,
    endedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return inserted.insertedId as mongoose.Types.ObjectId;
}

afterAll(async () => {
  for (const item of registered) item.socket.disconnect();
  if (!HAS_MONGO) return;
  const db = await mongoDb();
  if (!db) return;
  for (const item of registered) {
    const sessions = await db
      .collection('sessions')
      .find({ controllerId: item.controllerId })
      .project({ _id: 1 })
      .toArray();
    const sessionIds = sessions.map((doc) => doc._id);
    if (sessionIds.length > 0) {
      await db.collection('acpmessages').deleteMany({ sessionId: { $in: sessionIds } });
    }
    await db.collection('sessions').deleteMany({ controllerId: item.controllerId });
    await db.collection('controllerworkspaces').deleteMany({ controllerId: item.controllerId });
    await db.collection('controllers').deleteOne({ _id: item.controllerId });
  }
});

// ---------------------------------------------------------------------------

describe.skipIf(!HAS_MONGO)('Session archive API (T-ARCH-API*)', () => {
  it('T-ARCH-API1: archiveSession 未认证 → Not authenticated', async () => {
    const res = await gql(ARCHIVE_SESSION, { id: new mongoose.Types.ObjectId().toString(), archived: true });
    expect(res.data).toBeNull();
    expect(res.errors?.[0]?.message).toContain('Not authenticated');
  });

  it('T-ARCH-API2: 归档/取消归档成功，DB archivedAt 往返且幂等', async () => {
    const db = (await mongoDb())!;
    const fixture = await createFixture('api2');
    const wsId = await fixture.createWorkspace(`/tmp/arch-api2-${Date.now()}`);
    const session = await fixture.createSession(wsId);
    const sessionId = new mongoose.Types.ObjectId(session.id);

    // 归档
    const archive = await gql(ARCHIVE_SESSION, { id: session.id, archived: true }, fixture.token);
    expect(archive.errors).toBeUndefined();
    expect(archive.data.archiveSession).toBe(true);
    const archivedDoc = await db.collection('sessions').findOne({ _id: sessionId });
    expect(archivedDoc?.archivedAt).toBeInstanceOf(Date);

    // GraphQL 透出 archived=true；活跃列表（默认口径）不再包含
    const detail = await gql(SESSION, { id: session.id }, fixture.token);
    expect(detail.errors).toBeUndefined();
    expect(detail.data.session).toMatchObject({ id: session.id, archived: true });
    const active = await gql(SESSIONS, {}, fixture.token);
    expect(active.data.sessions.map((s: { id: string }) => s.id)).not.toContain(session.id);

    // 幂等：重复归档仍为已归档
    const again = await gql(ARCHIVE_SESSION, { id: session.id, archived: true }, fixture.token);
    expect(again.data.archiveSession).toBe(true);
    const stillArchived = await db.collection('sessions').findOne({ _id: sessionId });
    expect(stillArchived?.archivedAt).toBeInstanceOf(Date);

    // 取消归档
    const unarchive = await gql(ARCHIVE_SESSION, { id: session.id, archived: false }, fixture.token);
    expect(unarchive.data.archiveSession).toBe(true);
    const unarchivedDoc = await db.collection('sessions').findOne({ _id: sessionId });
    expect(unarchivedDoc?.archivedAt).toBeNull();
    const detail2 = await gql(SESSION, { id: session.id }, fixture.token);
    expect(detail2.data.session.archived).toBe(false);
    const active2 = await gql(SESSIONS, {}, fixture.token);
    expect(active2.data.sessions.map((s: { id: string }) => s.id)).toContain(session.id);
  });

  it('T-ARCH-API3: 节点会话拒绝 ARCHIVE_WORKFLOW_SESSION_UNSUPPORTED；sessions(archived) 三档口径', async () => {
    const db = (await mongoDb())!;
    const fixture = await createFixture('api3');
    const wsId = await fixture.createWorkspace(`/tmp/arch-api3-${Date.now()}`);
    const a = await fixture.createSession(wsId);
    const b = await fixture.createSession(wsId);
    const workflowSessionId = await insertWorkflowSession(fixture);

    // 工作流节点会话拒绝且不写库
    const reject = await gql(ARCHIVE_SESSION, { id: workflowSessionId.toString(), archived: true }, fixture.token);
    expect(reject.data).toBeNull();
    expect(reject.errors?.[0]?.message).toBe('ARCHIVE_WORKFLOW_SESSION_UNSUPPORTED');
    const workflowDoc = await db.collection('sessions').findOne({ _id: workflowSessionId });
    expect(workflowDoc?.archivedAt).toBeNull();

    // 归档 A 后三档口径
    await gql(ARCHIVE_SESSION, { id: a.id, archived: true }, fixture.token);

    const defaultList = await gql(SESSIONS, {}, fixture.token);
    const defaultIds = defaultList.data.sessions.map((s: { id: string }) => s.id);
    expect(defaultIds).toContain(b.id);
    expect(defaultIds).not.toContain(a.id);
    expect(defaultIds).not.toContain(workflowSessionId.toString());

    const activeFalse = await gql(SESSIONS, { archived: false }, fixture.token);
    const falseIds = activeFalse.data.sessions.map((s: { id: string }) => s.id);
    expect(falseIds).toContain(b.id);
    expect(falseIds).not.toContain(a.id);

    const archivedTrue = await gql(SESSIONS, { archived: true }, fixture.token);
    const trueIds = archivedTrue.data.sessions.map((s: { id: string }) => s.id);
    expect(trueIds).toContain(a.id);
    expect(trueIds).not.toContain(b.id);
    expect(trueIds).not.toContain(workflowSessionId.toString());

    // 与 includeWorkflowSessions 正交：归档的节点会话仅在 includeWorkflowSessions=true 时出现
    await db
      .collection('sessions')
      .updateOne({ _id: workflowSessionId }, { $set: { archivedAt: new Date() } });
    const archivedWithWorkflow = await gql(
      SESSIONS,
      { archived: true, includeWorkflowSessions: true },
      fixture.token,
    );
    expect(archivedWithWorkflow.data.sessions.map((s: { id: string }) => s.id)).toContain(
      workflowSessionId.toString(),
    );
    const archivedOnly = await gql(SESSIONS, { archived: true }, fixture.token);
    expect(archivedOnly.data.sessions.map((s: { id: string }) => s.id)).not.toContain(
      workflowSessionId.toString(),
    );
  });

  it('T-ARCH-API4: homeOverview.archivedSessions 与 sessions 互补，sessionTotalCount 为未归档计数', async () => {
    const fixture = await createFixture('api4');
    const wsId = await fixture.createWorkspace(`/tmp/arch-api4-${Date.now()}`);
    const s1 = await fixture.createSession(wsId);
    const s2 = await fixture.createSession(wsId);
    await gql(ARCHIVE_SESSION, { id: s2.id, archived: true }, fixture.token);

    const res = await gql(HOME_OVERVIEW, undefined, fixture.token);
    expect(res.errors).toBeUndefined();
    const home = res.data.homeOverview;
    const activeIds = home.sessions.map((s: { id: string }) => s.id);
    const archivedIds = home.archivedSessions.map((s: { id: string }) => s.id);

    expect(activeIds).toContain(s1.id);
    expect(activeIds).not.toContain(s2.id);
    expect(archivedIds).toEqual([s2.id]);
    expect(home.archivedSessions[0].archived).toBe(true);
    // 计数口径：sessionTotalCount = 未归档活跃会话数
    expect(home.sessionTotalCount).toBe(home.sessions.length);
    expect(home.sessionTotalCount).toBe(1);
  });
});

describe.skipIf(!HAS_MONGO)('Workspace delete cascade archive API (T-WSARC-API*)', () => {
  it('T-WSARC-API1: deleteWorkspace 连带：会话 archivedAt 非空、活跃会话 ended、工作区行删除', async () => {
    const db = (await mongoDb())!;
    const fixture = await createFixture('wsarc1');
    const wsId = await fixture.createWorkspace(`/tmp/wsarc1-${Date.now()}`);
    const session = await fixture.createSession(wsId);
    expect(['creating', 'connecting', 'idling', 'running']).toContain(session.status);

    const del = await gql(DELETE_WORKSPACE, { id: wsId }, fixture.token);
    expect(del.errors).toBeUndefined();
    expect(del.data.deleteWorkspace).toBe(true);

    // 工作区行已删除
    const wsRow = await db
      .collection('controllerworkspaces')
      .findOne({ _id: new mongoose.Types.ObjectId(wsId) });
    expect(wsRow).toBeNull();

    // 会话连带归档 + 先结束
    const doc = await db
      .collection('sessions')
      .findOne({ _id: new mongoose.Types.ObjectId(session.id) });
    expect(doc?.archivedAt).toBeInstanceOf(Date);
    expect(doc?.status).toBe('ended');

    // 从活跃列表消失、出现在已归档列表
    const active = await gql(SESSIONS, {}, fixture.token);
    expect(active.data.sessions.map((s: { id: string }) => s.id)).not.toContain(session.id);
    const archived = await gql(SESSIONS, { archived: true }, fixture.token);
    expect(archived.data.sessions.map((s: { id: string }) => s.id)).toContain(session.id);
  });

  it('T-WSARC-API2: workspaceArchiveImpact.sessionCount = 实际连带归档数量（不含其它工作区）', async () => {
    const db = (await mongoDb())!;
    const fixture = await createFixture('wsarc2');
    const ws1 = await fixture.createWorkspace(`/tmp/wsarc2-a-${Date.now()}`);
    const ws2 = await fixture.createWorkspace(`/tmp/wsarc2-b-${Date.now()}`);
    const s1 = await fixture.createSession(ws1);
    const s2 = await fixture.createSession(ws1);
    const other = await fixture.createSession(ws2);

    const impact = await gql(WORKSPACE_ARCHIVE_IMPACT, { id: ws1 }, fixture.token);
    expect(impact.errors).toBeUndefined();
    expect(impact.data.workspaceArchiveImpact.sessionCount).toBe(2);

    const del = await gql(DELETE_WORKSPACE, { id: ws1 }, fixture.token);
    expect(del.data.deleteWorkspace).toBe(true);

    // 实际连带归档数量与提示数量一致
    const archivedIds = await db
      .collection('sessions')
      .find({
        controllerWorkspaceId: new mongoose.Types.ObjectId(ws1),
        archivedAt: { $ne: null },
      })
      .project({ _id: 1 })
      .toArray();
    expect(archivedIds.map((doc) => String(doc._id)).sort()).toEqual(
      [s1.id, s2.id].sort(),
    );

    // 其它工作区会话不受影响
    const otherDoc = await db
      .collection('sessions')
      .findOne({ _id: new mongoose.Types.ObjectId(other.id) });
    expect(otherDoc?.archivedAt).toBeNull();
  });
});
