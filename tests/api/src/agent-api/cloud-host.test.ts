import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';

// 前台云电脑 API（需要 Aspire 全量服务 + HARNESS_ENABLED=true）。
// `K8S_ENABLED=false` 下 create 只能停在 STARTING；在线/默认会话由单测与真实集群验收覆盖。
const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const HARNESS_ENABLED = process.env.HARNESS_ENABLED === 'true';
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

function gql(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  }).then((res) => res.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>);
}

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) { token user { id } }
  }
`;

const CAPABILITIES = `query { cloudHostCapabilities { enabled supportedHarnesses } }`;

const MY_HOSTS = `
  query {
    myCloudHosts {
      id name controllerId status harnessTypes defaultSessionId activeSessionCount
      containerId createdAt readyAt stoppedAt failureReason deletedAt
    }
  }
`;

const CREATE = `
  mutation CreateCloudHost($input: CreateCloudHostInput!) {
    createCloudHost(input: $input) {
      id name controllerId status harnessTypes defaultSessionId activeSessionCount
    }
  }
`;

const CONTROLLERS = `query { controllers { id name hostname type status cloudHost { id status } } }`;
const WORKSPACES = `query { workspaces { id name path controllerId } }`;
const KEYS = `query { controllerKeys { id name type keyPrefix } }`;

const STOP_IMPACT = `query Impact($id: ID!) { cloudHostStopImpact(id: $id) { activeSessionCount sessionsWillBeLost sessions { id title status acpServerType } } }`;

const STOP = `mutation Stop($id: ID!, $force: Boolean) { stopCloudHost(id: $id, force: $force) { id status stoppedAt } }`;

const DELETE = `mutation Delete($id: ID!) { deleteCloudHost(id: $id) }`;

const HOME = `query { homeOverview { controllers { id type name cloudHost { id status } } } }`;

async function signup(): Promise<string> {
  const username = `ch${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
  const result = await gql(SIGNUP, { username, password: 'password123' });
  return result.data.signup.token as string;
}

async function signupWithId(): Promise<{ token: string; userId: string }> {
  const username = `ch${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
  const result = await gql(SIGNUP, { username, password: 'password123' });
  return {
    token: result.data.signup.token as string,
    userId: result.data.signup.user.id as string,
  };
}

describe.skipIf(HARNESS_ENABLED)('Cloud Host API (feature disabled)', () => {
  it('T-CH2: capabilities disabled and create rejected', async () => {
    const token = await signup();
    const capabilities = await gql(CAPABILITIES, undefined, token);
    expect(capabilities.errors).toBeUndefined();
    expect(capabilities.data.cloudHostCapabilities).toEqual({
      enabled: false,
      supportedHarnesses: [],
    });

    const created = await gql(
      CREATE,
      { input: { name: 'cloud', harnessTypes: ['OPENCODE'] } },
      token,
    );
    expect(created.errors?.[0].message).toBe('harness feature is disabled');
  });
});

describe.skipIf(!HARNESS_ENABLED)('Cloud Host API', () => {
  it('T-CH1: capabilities exposes OPENCODE when enabled', async () => {
    const token = await signup();
    const result = await gql(CAPABILITIES, undefined, token);
    expect(result.errors).toBeUndefined();
    expect(result.data.cloudHostCapabilities).toEqual({
      enabled: true,
      supportedHarnesses: ['OPENCODE'],
    });
  });

  it('T-CH3/T-CH4: validates name and harnessTypes', async () => {
    const token = await signup();
    const emptyName = await gql(CREATE, { input: { name: '   ', harnessTypes: ['OPENCODE'] } }, token);
    expect(emptyName.errors?.[0].message).toBe('name is required');

    const longName = await gql(
      CREATE,
      { input: { name: 'x'.repeat(65), harnessTypes: ['OPENCODE'] } },
      token,
    );
    expect(longName.errors?.[0].message).toBe('name is too long');

    const noHarness = await gql(CREATE, { input: { name: 'cloud', harnessTypes: [] } }, token);
    expect(noHarness.errors?.[0].message).toBe('at least one harness type is required');
  });

  it('T-CH7/T-CH10/T-CH11: create/list/owner isolation/1 instance/stop/delete', async () => {
    const token = await signup();
    const other = await signup();

    const created = await gql(
      CREATE,
      { input: { name: `cloud-${Date.now().toString(36)}`, harnessTypes: ['OPENCODE'] } },
      token,
    );
    expect(created.errors).toBeUndefined();
    const host = created.data.createCloudHost;
    expect(host).toMatchObject({
      status: 'STARTING',
      harnessTypes: ['OPENCODE'],
      activeSessionCount: 0,
    });

    // 创建成功结构：Controller 预创建（type=cloud/registering/用户命名）+ 默认工作区 +
    // ControllerKey 不出现在「未绑定 Key」列表。
    const controllers = await gql(CONTROLLERS, undefined, token);
    const createdController = controllers.data.controllers.find(
      (item: { id: string }) => item.id === host.controllerId,
    );
    expect(createdController).toMatchObject({
      type: 'cloud',
      status: 'registering',
      name: host.name,
    });
    const workspaces = await gql(WORKSPACES, undefined, token);
    expect(
      workspaces.data.workspaces.some(
        (workspace: { controllerId: string; path: string }) =>
          workspace.controllerId === host.controllerId && workspace.path === '/root/workspace',
      ),
    ).toBe(true);
    const keys = await gql(KEYS, undefined, token);
    expect(keys.data.controllerKeys.some((key: { type: string }) => key.type === 'cloud')).toBe(
      false,
    );

    const second = await gql(CREATE, { input: { name: 'another', harnessTypes: ['OPENCODE'] } }, token);
    expect(second.errors?.[0].message).toBe('too many cloud hosts');

    const mine = await gql(MY_HOSTS, undefined, token);
    expect(mine.data.myCloudHosts.map((item: { id: string }) => item.id)).toContain(host.id);

    const theirs = await gql(MY_HOSTS, undefined, other);
    expect(theirs.data.myCloudHosts.map((item: { id: string }) => item.id)).not.toContain(host.id);

    const foreignStop = await gql(STOP, { id: host.id, force: true }, other);
    expect(foreignStop.errors?.[0].message).toBe('Cloud host not found');

    // Controller.cloudHost：cloud 主机返回最新映射
    const home = await gql(HOME, undefined, token);
    const controller = home.data.homeOverview.controllers.find(
      (item: { id: string }) => item.id === host.controllerId,
    );
    expect(controller).toMatchObject({ type: 'cloud', cloudHost: { id: host.id } });

    const impact = await gql(STOP_IMPACT, { id: host.id }, token);
    expect(impact.data.cloudHostStopImpact).toMatchObject({
      activeSessionCount: 0,
      sessionsWillBeLost: false,
      sessions: [],
    });

    const stopped = await gql(STOP, { id: host.id, force: false }, token);
    expect(stopped.errors).toBeUndefined();
    expect(stopped.data.stopCloudHost.status).toBe('STOPPED');

    // 幂等
    await expect(gql(STOP, { id: host.id }, token)).resolves.toMatchObject({
      data: { stopCloudHost: { status: 'STOPPED' } },
    });

    const deleted = await gql(DELETE, { id: host.id }, token);
    expect(deleted.data.deleteCloudHost).toBe(true);
    await expect(gql(DELETE, { id: host.id }, token)).resolves.toMatchObject({
      data: { deleteCloudHost: true },
    });

    const afterDelete = await gql(MY_HOSTS, undefined, token);
    expect(afterDelete.data.myCloudHosts.map((item: { id: string }) => item.id)).not.toContain(
      host.id,
    );

    // 软删除后列表语义 = 整条过滤（homeOverview 复用 controllerService.findAllByUser）：
    // Controller/会话/消息在 DB 留档，但不再出现在任何列表；会话级 cloudHost 留档由
    // tests/api session-readonly 的 GET_SESSION 用例断言。
    const homeAfter = await gql(HOME, undefined, token);
    const offlined = homeAfter.data.homeOverview.controllers.find(
      (item: { id: string }) => item.id === host.controllerId,
    );
    expect(offlined).toBeUndefined();
  });

  it.skipIf(!HAS_MONGO)('R2-11: soft delete keeps DB archive row (cloudhosts.deletedAt + controllers row)', async () => {
    const db = (await mongoDb())!;
    const token = await signup();
    const created = await gql(
      CREATE,
      { input: { name: `del-db-${Date.now().toString(36)}`, harnessTypes: ['OPENCODE'] } },
      token,
    );
    const host = created.data.createCloudHost;
    try {
      await gql(STOP, { id: host.id, force: true }, token);
      await gql(DELETE, { id: host.id }, token);

      const hostDoc = await db.collection('cloudhosts').findOne({
        _id: new mongoose.Types.ObjectId(host.id),
      });
      expect(hostDoc?.deletedAt).not.toBeNull();
      const controllerDoc = await db.collection('controllers').findOne({
        _id: new mongoose.Types.ObjectId(host.controllerId),
      });
      expect(controllerDoc).toBeTruthy();
    } finally {
      await db.collection('cloudhosts').deleteOne({ _id: new mongoose.Types.ObjectId(host.id) });
      await db.collection('controllers').deleteOne({
        _id: new mongoose.Types.ObjectId(host.controllerId),
      });
      await db.collection('controllerworkspaces').deleteMany({ controllerId: new mongoose.Types.ObjectId(host.controllerId) });
      await db.collection('sessions').deleteMany({ controllerId: new mongoose.Types.ObjectId(host.controllerId) });
    }
  });

  it('T-CH17: refuses to delete a non-terminal cloud host', async () => {
    const token = await signup();
    const created = await gql(
      CREATE,
      { input: { name: `del-${Date.now().toString(36)}`, harnessTypes: ['OPENCODE'] } },
      token,
    );
    const host = created.data.createCloudHost;
    const deleted = await gql(DELETE, { id: host.id }, token);
    expect(deleted.errors?.[0].message).toBe('stop the cloud host before deleting');

    await gql(STOP, { id: host.id, force: true }, token);
    await gql(DELETE, { id: host.id }, token);
  });

  it.skipIf(!HAS_MONGO)(
    'T-CH13/T-CH14: stop with active sessions requires force and then ends them',
    async () => {
      const db = (await mongoDb())!;
      const { token, userId } = await signupWithId();
      const hostId = new mongoose.Types.ObjectId();
      const controllerId = new mongoose.Types.ObjectId();
      const now = new Date();
      try {
        await db.collection('cloudhosts').insertOne({
          _id: hostId,
          userId: new mongoose.Types.ObjectId(userId),
          name: `active-${hostId.toString()}`,
          harnessTypes: ['OPENCODE'],
          status: 'RUNNING',
          controllerId,
          keyId: new mongoose.Types.ObjectId(),
          workspaceId: new mongoose.Types.ObjectId(),
          containerId: null,
          defaultSessionId: null,
          startedAt: now,
          readyAt: now,
          stoppedAt: null,
          failureReason: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        await db.collection('sessions').insertOne({
          userId: new mongoose.Types.ObjectId(userId),
          controllerId,
          controllerName: 'cloud',
          acpServerType: 'opencode',
          status: 'idling',
          title: 'active',
          createdAt: now,
          updatedAt: now,
        });

        const impact = await gql(STOP_IMPACT, { id: hostId.toString() }, token);
        expect(impact.data.cloudHostStopImpact).toMatchObject({
          activeSessionCount: 1,
          sessionsWillBeLost: true,
        });

        const rejected = await gql(STOP, { id: hostId.toString(), force: false }, token);
        expect(rejected.errors?.[0].message).toBe(
          'stopping this cloud host will permanently lose all active sessions',
        );

        const stopped = await gql(STOP, { id: hostId.toString(), force: true }, token);
        expect(stopped.errors).toBeUndefined();
        expect(stopped.data.stopCloudHost.status).toBe('STOPPED');
        const session = await db.collection('sessions').findOne({ controllerId });
        expect(session?.status).toBe('ended');
      } finally {
        await db.collection('sessions').deleteMany({ controllerId });
        await db.collection('cloudhosts').deleteOne({ _id: hostId });
      }
    },
  );

  it.skipIf(!HAS_MONGO)('T-CH25: local controllers expose cloudHost=null', async () => {
    const db = (await mongoDb())!;
    const { token, userId } = await signupWithId();
    const controllerId = new mongoose.Types.ObjectId();
    const now = new Date();
    try {
      await db.collection('controllers').insertOne({
        _id: controllerId,
        userId: new mongoose.Types.ObjectId(userId),
        name: 'local-host',
        hostname: 'local-host',
        type: 'local',
        status: 'online',
        keyId: new mongoose.Types.ObjectId(),
        version: '2.5.0',
        createdAt: now,
        updatedAt: now,
      });
      const controllers = await gql(CONTROLLERS, undefined, token);
      const local = controllers.data.controllers.find(
        (item: { id: string }) => item.id === controllerId.toString(),
      );
      expect(local).toMatchObject({ type: 'local', cloudHost: null });
    } finally {
      await db.collection('controllers').deleteOne({ _id: controllerId });
    }
  });

  it('T-CH28: all entries require authentication', async () => {
    for (const [query, variables] of [
      [CAPABILITIES, undefined],
      [MY_HOSTS, undefined],
      [STOP_IMPACT, { id: '000000000000000000000000' }],
      [CREATE, { input: { name: 'x', harnessTypes: ['OPENCODE'] } }],
      [DELETE, { id: '000000000000000000000000' }],
    ] as Array<[string, Record<string, unknown> | undefined]>) {
      const result = await gql(query, variables);
      expect(result.errors?.[0].message).toBe('Not authenticated');
    }
  });
});
