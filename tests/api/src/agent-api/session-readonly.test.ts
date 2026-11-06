import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { createFrontUser } from '../support/front-users.js';
import { personalGlobalWorkspaceId } from '../support/workspace-fixtures.js';

// 会话只读：云电脑终态后 resume 被拒绝；非 RUNNING 云电脑不允许 createSession。
// 普通 ended 会话仍可 resume（回归）。
// T-RO-API1~3（Phase 9）：控制器缺失 / 工作区缺失走统一只读判定（`session is ended`），
// `session.readOnlyReason` 三态（CONTROLLER_MISSING / WORKSPACE_MISSING / CLOUD_HOST_DESTROYED）+ 完好为 null。
const GRAPHQL_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

function gql(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(GRAPHQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  }).then((res) => res.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>);
}

const RESUME = `mutation Resume($id: ID!) { resumeSession(id: $id) { success status error } }`;

const CREATE_SESSION = `
  mutation Create($input: CreateSessionInput!) {
    createSession(input: $input) { session { id status } }
  }
`;

const SESSION_READONLY_FIELDS = `
  query Session($id: ID!) {
    session(id: $id) {
      id
      status
      controllerType
      cloudHost { id status deletedAt }
    }
  }
`;

const CONTROLLERS = `query { controllers { id type } }`;

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

async function seedCloudController(
  db: mongoose.mongo.Db,
  userId: string,
  status: 'STARTING' | 'STOPPED',
) {
  const now = new Date();
  const controllerId = new mongoose.Types.ObjectId();
  const hostId = new mongoose.Types.ObjectId();
  const workspaceId = new mongoose.Types.ObjectId();
  const globalWorkspaceId = await personalGlobalWorkspaceId(db, userId);
  await db.collection('controllers').insertOne({
    _id: controllerId,
    userId: new mongoose.Types.ObjectId(userId),
    tenantId: new mongoose.Types.ObjectId(userId),
    workspaceId: globalWorkspaceId,
    name: `ro-${controllerId.toString()}`,
    hostname: `ro-${controllerId.toString()}`,
    type: 'cloud',
    status: status === 'STOPPED' ? 'offline' : 'registering',
    keyId: new mongoose.Types.ObjectId(),
    version: '2.5.0',
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('controllerworkspaces').insertOne({
    _id: workspaceId,
    userId: new mongoose.Types.ObjectId(userId),
    tenantId: new mongoose.Types.ObjectId(userId),
    controllerId,
    name: 'workspace',
    path: '/home/worker/workspace',
    isEnabled: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('cloudhosts').insertOne({
    _id: hostId,
    userId: new mongoose.Types.ObjectId(userId),
    tenantId: new mongoose.Types.ObjectId(userId),
    name: `ro-${hostId.toString()}`,
    harnessTypes: ['OPENCODE'],
    status,
    controllerId,
    keyId: new mongoose.Types.ObjectId(),
    workspaceId,
    resourceWorkspaceId: globalWorkspaceId,
    containerId: null,
    defaultSessionId: null,
    startedAt: now,
    readyAt: status === 'STOPPED' ? now : null,
    stoppedAt: status === 'STOPPED' ? now : null,
    failureReason: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return { controllerId, workspaceId, hostId };
}

/** 兜底清理本用例创建的云主机 fixture（Controller/工作区/云电脑/会话，按唯一 controllerId 匹配）。 */
async function cleanupCloudFixture(
  db: mongoose.mongo.Db,
  controllerId: mongoose.Types.ObjectId,
): Promise<void> {
  await db.collection('sessions').deleteMany({ controllerId });
  await db.collection('cloudhosts').deleteMany({ controllerId });
  await db.collection('controllerworkspaces').deleteMany({ controllerId });
  await db.collection('controllers').deleteOne({ _id: controllerId });
}

describe.skipIf(!HAS_MONGO)('Cloud Host session readonly', () => {
  it('rejects resume for sessions on stopped cloud hosts', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const token = frontUser.token;
    const userId = frontUser.userId;
    const { controllerId } = await seedCloudController(db, userId, 'STOPPED');
    try {
      const now = new Date();
      const inserted = await db.collection('sessions').insertOne({
        userId: new mongoose.Types.ObjectId(userId),
        tenantId: new mongoose.Types.ObjectId(userId),
        workspaceId: await personalGlobalWorkspaceId(db, userId),
        controllerId,
        controllerName: 'cloud',
        acpServerType: 'opencode',
        status: 'ended',
        title: 'archived',
        endedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const result = await gql(RESUME, { id: inserted.insertedId.toString() }, token);
      expect(result.errors).toBeUndefined();
      expect(result.data.resumeSession).toEqual({
        success: false,
        status: 'ended',
        error: 'session is ended',
      });
    } finally {
      await cleanupCloudFixture(db, controllerId);
    }
  });

  it('keeps normal ended sessions resumable', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const token = frontUser.token;
    const userId = frontUser.userId;
    const now = new Date();
    const controllerId = new mongoose.Types.ObjectId();
    try {
      await db.collection('controllers').insertOne({
        _id: controllerId,
        userId: new mongoose.Types.ObjectId(userId),
        tenantId: new mongoose.Types.ObjectId(userId),
        workspaceId: await personalGlobalWorkspaceId(db, userId),
        name: 'local',
        hostname: 'local',
        type: 'local',
        status: 'online',
        keyId: new mongoose.Types.ObjectId(),
        version: '2.5.0',
        createdAt: now,
        updatedAt: now,
      });
      const inserted = await db.collection('sessions').insertOne({
        userId: new mongoose.Types.ObjectId(userId),
        tenantId: new mongoose.Types.ObjectId(userId),
        workspaceId: await personalGlobalWorkspaceId(db, userId),
        controllerId,
        controllerName: 'local',
        acpServerType: 'opencode',
        status: 'ended',
        title: 'normal-ended',
        endedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const result = await gql(RESUME, { id: inserted.insertedId.toString() }, token);
      expect(result.errors).toBeUndefined();
      expect(result.data.resumeSession).toMatchObject({ success: true, status: 'connecting' });
    } finally {
      await db.collection('sessions').deleteMany({ controllerId });
      await db.collection('controllers').deleteOne({ _id: controllerId });
    }
  });

  it('rejects resume while cloud host is STOPPING', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const token = frontUser.token;
    const userId = frontUser.userId;
    const { controllerId } = await seedCloudController(db, userId, 'STOPPED');
    try {
      await db
        .collection('cloudhosts')
        .updateOne({ controllerId }, { $set: { status: 'STOPPING' } });
      const now = new Date();
      const inserted = await db.collection('sessions').insertOne({
        userId: new mongoose.Types.ObjectId(userId),
        tenantId: new mongoose.Types.ObjectId(userId),
        workspaceId: await personalGlobalWorkspaceId(db, userId),
        controllerId,
        controllerName: 'cloud',
        acpServerType: 'opencode',
        status: 'ended',
        title: 'stopping',
        endedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const result = await gql(RESUME, { id: inserted.insertedId.toString() }, token);
      expect(result.data.resumeSession).toEqual({
        success: false,
        status: 'ended',
        error: 'session is ended',
      });
    } finally {
      await cleanupCloudFixture(db, controllerId);
    }
  });

  it('rejects createSession while cloud host is not RUNNING', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const token = frontUser.token;
    const userId = frontUser.userId;
    const { controllerId, workspaceId } = await seedCloudController(db, userId, 'STARTING');

    try {
      const result = await gql(
        CREATE_SESSION,
        {
          input: {
            controllerId: controllerId.toString(),
            workspaceId: workspaceId.toString(),
            acpServerType: 'opencode',
          },
        },
        token,
      );
      expect(result.errors?.[0].message).toBe('cloud host is not running');
    } finally {
      await cleanupCloudFixture(db, controllerId);
    }
  });

  it('R2-1: soft-deleted cloud host session returns controllerType/cloudHost via real GET_SESSION', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const token = frontUser.token;
    const userId = frontUser.userId;
    const { controllerId, hostId } = await seedCloudController(db, userId, 'STOPPED');
    const now = new Date();
    await db
      .collection('cloudhosts')
      .updateOne({ _id: hostId }, { $set: { deletedAt: now } });
    try {
      const inserted = await db.collection('sessions').insertOne({
        userId: new mongoose.Types.ObjectId(userId),
        tenantId: new mongoose.Types.ObjectId(userId),
        workspaceId: await personalGlobalWorkspaceId(db, userId),
        controllerId,
        controllerName: 'cloud',
        acpServerType: 'opencode',
        status: 'ended',
        title: 'soft-deleted-archive',
        endedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const result = await gql(
        SESSION_READONLY_FIELDS,
        { id: inserted.insertedId.toString() },
        token,
      );
      expect(result.errors).toBeUndefined();
      // 真实 GraphQL 响应锚点：字段 resolver 必须已注册（R2-1），且软删留档可返回
      expect(result.data.session).toMatchObject({
        controllerType: 'cloud',
        cloudHost: {
          id: hostId.toString(),
          status: 'STOPPED',
        },
      });
      expect(result.data.session.cloudHost.deletedAt).toBeTruthy();

      // 列表语义：软删后整条过滤，前端不得再依赖 controllers 命中
      const controllers = await gql(CONTROLLERS, undefined, token);
      expect(
        controllers.data.controllers.map((item: { id: string }) => item.id),
      ).not.toContain(controllerId.toString());
    } finally {
      await cleanupCloudFixture(db, controllerId);
    }
  });
});

// ---------------------------------------------------------------------------
// T-RO-API1~3：统一只读判定（控制器缺失 / 工作区缺失）与 `session.readOnlyReason` 三态透出。
// 与既有云电脑用例共处同一文件（同一 skipIf 口径：缺 MONGODB_URI 时整套跳过）。
// ---------------------------------------------------------------------------

const SEND_MESSAGE = `
  mutation Send($sessionId: ID!, $content: String!) {
    sendSessionMessage(sessionId: $sessionId, content: $content) { id }
  }
`;

const SESSION_REASON = `
  query Session($id: ID!) {
    session(id: $id) { id archived readOnlyReason }
  }
`;

const ARCHIVE_SESSION = `
  mutation Archive($id: ID!, $archived: Boolean!) { archiveSession(id: $id, archived: $archived) }
`;

const DELETE_WORKSPACE = `mutation Delete($id: ID!) { deleteWorkspace(id: $id) }`;

interface LocalSessionEnv {
  controllerId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId | null;
  sessionId: mongoose.Types.ObjectId;
}

/**
 * 直插本地控制器 +（可选）项目工作区 + ended 会话。
 * 新数据口径：会话带 `controllerWorkspaceId` 与 `cwd`，落个人全局租户工作区（作用域可见）。
 */
async function seedLocalSession(
  db: mongoose.mongo.Db,
  userId: string,
  options: { withWorkspace?: boolean } = {},
): Promise<LocalSessionEnv> {
  const now = new Date();
  const globalWorkspaceId = await personalGlobalWorkspaceId(db, userId);
  const controllerId = new mongoose.Types.ObjectId();
  await db.collection('controllers').insertOne({
    _id: controllerId,
    userId: new mongoose.Types.ObjectId(userId),
    tenantId: new mongoose.Types.ObjectId(userId),
    workspaceId: globalWorkspaceId,
    name: `ro-api-${controllerId.toString()}`,
    hostname: `ro-api-${controllerId.toString()}`,
    type: 'local',
    status: 'online',
    keyId: new mongoose.Types.ObjectId(),
    version: '2.5.0',
    createdAt: now,
    updatedAt: now,
  });

  let workspaceId: mongoose.Types.ObjectId | null = null;
  let path: string | undefined;
  if (options.withWorkspace !== false) {
    workspaceId = new mongoose.Types.ObjectId();
    path = `/tmp/ro-api-${controllerId.toString()}`;
    await db.collection('controllerworkspaces').insertOne({
      _id: workspaceId,
      userId: new mongoose.Types.ObjectId(userId),
      tenantId: new mongoose.Types.ObjectId(userId),
      controllerId,
      name: 'workspace',
      path,
      isEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  const inserted = await db.collection('sessions').insertOne({
    userId: new mongoose.Types.ObjectId(userId),
    tenantId: new mongoose.Types.ObjectId(userId),
    workspaceId: globalWorkspaceId,
    controllerId,
    controllerName: 'local',
    acpServerType: 'opencode',
    status: 'ended',
    title: 'ro-api-session',
    cwd: path ?? null,
    controllerWorkspaceId: workspaceId,
    archivedAt: null,
    endedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return { controllerId, workspaceId, sessionId: inserted.insertedId as mongoose.Types.ObjectId };
}

async function cleanupLocalEnv(db: mongoose.mongo.Db, env: LocalSessionEnv): Promise<void> {
  await db.collection('sessions').deleteOne({ _id: env.sessionId });
  if (env.workspaceId) {
    await db.collection('controllerworkspaces').deleteOne({ _id: env.workspaceId });
  }
  await db.collection('controllers').deleteOne({ _id: env.controllerId });
}

describe.skipIf(!HAS_MONGO)('Session readonly after controller removal (T-RO-API1)', () => {
  it('T-RO-API1: 删除控制器后 resume / sendSessionMessage 均拒绝 `session is ended`', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const env = await seedLocalSession(db, frontUser.userId);
    try {
      // 模拟 unbind 删除控制器
      await db.collection('controllers').deleteOne({ _id: env.controllerId });
      const sessionId = env.sessionId.toString();

      const resume = await gql(RESUME, { id: sessionId }, frontUser.token);
      expect(resume.errors).toBeUndefined();
      expect(resume.data.resumeSession).toEqual({
        success: false,
        status: 'ended',
        error: 'session is ended',
      });

      const send = await gql(SEND_MESSAGE, { sessionId, content: 'should be rejected' }, frontUser.token);
      expect(send.data).toBeNull();
      expect(send.errors?.[0]?.message).toBe('session is ended');
    } finally {
      await cleanupLocalEnv(db, env);
    }
  });
});

describe.skipIf(!HAS_MONGO)('Session readonly after workspace removal (T-RO-API2)', () => {
  it('T-RO-API2: 删除工作区连带归档后取消归档，会话同样只读并拒绝写操作', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const env = await seedLocalSession(db, frontUser.userId);
    try {
      const sessionId = env.sessionId.toString();
      const workspaceId = env.workspaceId!.toString();

      // 删除工作区（连带归档）
      const del = await gql(DELETE_WORKSPACE, { id: workspaceId }, frontUser.token);
      expect(del.errors).toBeUndefined();
      expect(del.data.deleteWorkspace).toBe(true);
      const archivedDoc = await db.collection('sessions').findOne({ _id: env.sessionId });
      expect(archivedDoc?.archivedAt).toBeInstanceOf(Date);

      // 取消归档：仅恢复分组展示，不恢复可写性（工作区仍缺失）
      const unarchive = await gql(ARCHIVE_SESSION, { id: sessionId, archived: false }, frontUser.token);
      expect(unarchive.data.archiveSession).toBe(true);
      const unarchivedDoc = await db.collection('sessions').findOne({ _id: env.sessionId });
      expect(unarchivedDoc?.archivedAt).toBeNull();

      const resume = await gql(RESUME, { id: sessionId }, frontUser.token);
      expect(resume.errors).toBeUndefined();
      expect(resume.data.resumeSession).toEqual({
        success: false,
        status: 'ended',
        error: 'session is ended',
      });

      const send = await gql(SEND_MESSAGE, { sessionId, content: 'should be rejected' }, frontUser.token);
      expect(send.data).toBeNull();
      expect(send.errors?.[0]?.message).toBe('session is ended');

      const reason = await gql(SESSION_REASON, { id: sessionId }, frontUser.token);
      expect(reason.errors).toBeUndefined();
      expect(reason.data.session.readOnlyReason).toBe('WORKSPACE_MISSING');
    } finally {
      await cleanupLocalEnv(db, env);
    }
  });
});

describe.skipIf(!HAS_MONGO)('Session readOnlyReason three states (T-RO-API3)', () => {
  it('T-RO-API3: readOnlyReason 三态透出，运行环境完好会话为 null', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const userId = frontUser.userId;
    const token = frontUser.token;

    const noController = await seedLocalSession(db, userId, { withWorkspace: false });
    const missingWorkspace = await seedLocalSession(db, userId);
    const healthy = await seedLocalSession(db, userId);
    const { controllerId: cloudControllerId } = await seedCloudController(db, userId, 'STOPPED');
    const now = new Date();
    const cloudSession = await db.collection('sessions').insertOne({
      userId: new mongoose.Types.ObjectId(userId),
      tenantId: new mongoose.Types.ObjectId(userId),
      workspaceId: await personalGlobalWorkspaceId(db, userId),
      controllerId: cloudControllerId,
      controllerName: 'cloud',
      acpServerType: 'opencode',
      status: 'ended',
      title: 'cloud-readonly',
      archivedAt: null,
      endedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    try {
      // 制造两处缺失
      await db.collection('controllers').deleteOne({ _id: noController.controllerId });
      await db
        .collection('controllerworkspaces')
        .deleteOne({ _id: missingWorkspace.workspaceId });

      const reasonOf = async (id: mongoose.Types.ObjectId) => {
        const res = await gql(SESSION_REASON, { id: id.toString() }, token);
        expect(res.errors).toBeUndefined();
        return res.data.session.readOnlyReason as string | null;
      };

      expect(await reasonOf(noController.sessionId)).toBe('CONTROLLER_MISSING');
      expect(await reasonOf(missingWorkspace.sessionId)).toBe('WORKSPACE_MISSING');
      expect(await reasonOf(cloudSession.insertedId as mongoose.Types.ObjectId)).toBe('CLOUD_HOST_DESTROYED');
      // 运行环境完好 → null（可写）
      expect(await reasonOf(healthy.sessionId)).toBeNull();
    } finally {
      await cleanupLocalEnv(db, noController);
      await cleanupLocalEnv(db, missingWorkspace);
      await cleanupLocalEnv(db, healthy);
      await db.collection('acpmessages').deleteMany({ sessionId: cloudSession.insertedId });
      await db.collection('sessions').deleteOne({ _id: cloudSession.insertedId });
      await cleanupCloudFixture(db, cloudControllerId);
    }
  });
});
