import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { createFrontUser } from '../support/front-users.js';

// 会话只读：云电脑终态后 resume 被拒绝；非 RUNNING 云电脑不允许 createSession。
// 普通 ended 会话仍可 resume（回归）。
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
  await db.collection('controllers').insertOne({
    _id: controllerId,
    userId: new mongoose.Types.ObjectId(userId),
    tenantId: new mongoose.Types.ObjectId(userId),
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
