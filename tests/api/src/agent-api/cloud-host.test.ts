import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { fundFrontUser } from './funding.js';
import { createFrontUser } from '../support/front-users.js';

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

const CAPABILITIES = `query { cloudHostCapabilities { enabled supportedHarnesses } }`;

const MY_HOSTS = `
  query {
    myCloudHosts {
      id name controllerId status harnessTypes defaultSessionId activeSessionCount
      containerId createdAt readyAt stoppedAt failureReason deletedAt hasDefaultWorkspace
    }
  }
`;

const CREATE = `
  mutation CreateCloudHost($input: CreateCloudHostInput!) {
    createCloudHost(input: $input) {
      id name controllerId status harnessTypes defaultSessionId activeSessionCount hasDefaultWorkspace
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

const INVOICES = `query { myBillingInvoices(page: 1, pageSize: 20) { id type amount refType refId description items { productId quantity unitPrice amount } receiptId } }`;
const RECEIPTS = `query { myBillingReceipts(page: 1, pageSize: 20) { id receiptNo invoiceId amount } }`;
const QUOTE = `query { cloudHostBillingQuote { createCredits perMinuteCredits availableBalance } }`;

async function newUserToken(): Promise<string> {
  const { token } = await createFrontUser();
  return token;
}

async function newFrontUser(): Promise<{ token: string; userId: string; username: string }> {
  return createFrontUser();
}

/** 创建云电脑需先扣 5 credits：为独立用户准备余额后返回 token。 */
async function fundedUserToken(cents = 10_000): Promise<string> {
  const { token, userId, username } = await newFrontUser();
  await fundFrontUser(userId, username, cents);
  return token;
}

describe.skipIf(HARNESS_ENABLED)('Cloud Host API (feature disabled)', () => {
  it('T-CH2: capabilities disabled and create rejected', async () => {
    const token = await newUserToken();
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
  it('T-CH1: capabilities exposes OPENCODE (and KIMI_CODE / DEEPSEEK_HARNESS once their presets exist)', async () => {
    const token = await newUserToken();
    const result = await gql(CAPABILITIES, undefined, token);
    expect(result.errors).toBeUndefined();
    expect(result.data.cloudHostCapabilities.enabled).toBe(true);
    expect(result.data.cloudHostCapabilities.supportedHarnesses).toContain('OPENCODE');
    // preset 由 admin-api 迁移 009/010 写入：存在即列出（缺失时跳过，不误伤旧库）
    if (HAS_MONGO) {
      const db = (await mongoDb())!;
      for (const [presetKey, harness] of [
        ['harness-kimi-code', 'KIMI_CODE'],
        ['harness-deepseek-harness', 'DEEPSEEK_HARNESS'],
      ] as const) {
        const preset = await db.collection('cloudworkloads').findOne({ presetKey });
        expect(result.data.cloudHostCapabilities.supportedHarnesses.includes(harness)).toBe(
          Boolean(preset),
        );
      }
    }
  });

  it('T-CH3/T-CH4: validates name and harnessTypes', async () => {
    const token = await newUserToken();
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

  it('T-CH7/T-CH10/T-CH11: create/list/owner isolation/multi-host/stop/delete', async () => {
    const token = await fundedUserToken();
    const other = await newUserToken();

    const created = await gql(
      CREATE,
      {
        input: {
          name: `cloud-${Date.now().toString(36)}`,
          harnessTypes: ['OPENCODE'],
        },
      },
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
          workspace.controllerId === host.controllerId && workspace.path === '/home/worker/workspace',
      ),
    ).toBe(false);
    const keys = await gql(KEYS, undefined, token);
    expect(keys.data.controllerKeys.some((key: { type: string }) => key.type === 'cloud')).toBe(
      false,
    );

    const second = await gql(CREATE, { input: { name: 'another', harnessTypes: ['OPENCODE'] } }, token);
    expect(second.errors).toBeUndefined();
    expect(second.data.createCloudHost.status).toBe('STARTING');

    const mine = await gql(MY_HOSTS, undefined, token);
    expect(mine.data.myCloudHosts.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([host.id, second.data.createCloudHost.id]),
    );

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

  it('T-CH-API-B1: 创建成功扣 5 credits 并生成账单/收据', async () => {
    const token = await fundedUserToken();
    const created = await gql(
      CREATE,
      { input: { name: `bill-${Date.now().toString(36)}`, harnessTypes: ['OPENCODE'] } },
      token,
    );
    expect(created.errors).toBeUndefined();
    const host = created.data.createCloudHost;

    const invoices = await gql(INVOICES, undefined, token);
    const charge = (invoices.data.myBillingInvoices as Array<Record<string, unknown>>).find(
      (item) => item.refType === 'cloud_host' && item.refId === host.id,
    );
    expect(charge).toMatchObject({ type: 'charge', amount: -5 });
    expect(charge?.receiptId).toBeTruthy();

    const receipts = await gql(RECEIPTS, undefined, token);
    expect(
      (receipts.data.myBillingReceipts as Array<Record<string, unknown>>).some(
        (item) => item.invoiceId === charge?.id && item.amount === 5,
      ),
    ).toBe(true);
  });

  it('T-CH-API-B2: 余额不足拒绝创建且无云电脑、无账单', async () => {
    const token = await newUserToken();
    const created = await gql(
      CREATE,
      { input: { name: `poor-${Date.now().toString(36)}`, harnessTypes: ['OPENCODE'] } },
      token,
    );
    expect(created.errors?.[0].message).toBe('insufficient balance');
    const hosts = await gql(MY_HOSTS, undefined, token);
    expect(hosts.data.myCloudHosts).toEqual([]);
    const invoices = await gql(INVOICES, undefined, token);
    expect(invoices.data.myBillingInvoices).toEqual([]);
  });

  it('T-CH-API-B3/B4: 连续创建 2 台成功，报价与实际扣费一致', async () => {
    const token = await fundedUserToken();
    const quote = await gql(QUOTE, undefined, token);
    expect(quote.data.cloudHostBillingQuote).toMatchObject({
      createCredits: 5,
      perMinuteCredits: 1,
    });
    for (const name of ['multi-a', 'multi-b']) {
      const result = await gql(
        CREATE,
        { input: { name: `${name}-${Date.now().toString(36)}`, harnessTypes: ['OPENCODE'] } },
        token,
      );
      expect(result.errors).toBeUndefined();
    }
    const hosts = await gql(MY_HOSTS, undefined, token);
    expect(hosts.data.myCloudHosts).toHaveLength(2);
    const invoices = await gql(INVOICES, undefined, token);
    const charges = (invoices.data.myBillingInvoices as Array<Record<string, unknown>>).filter(
      (item) => item.refType === 'cloud_host',
    );
    expect(charges).toHaveLength(2);
    expect(charges.every((item) => item.amount === -5)).toBe(true);
  });

  it('T-CH-DW1: 创建期不预置默认工作区（hasDefaultWorkspace=false、工作区列表为空、不自动建会话）', async () => {
    const createAndInspect = async (input: Record<string, unknown>) => {
      const token = await fundedUserToken();
      const created = await gql(
        CREATE,
        { input: { name: `dw-${Date.now().toString(36)}`, harnessTypes: ['OPENCODE'], ...input } },
        token,
      );
      expect(created.errors).toBeUndefined();
      const host = created.data.createCloudHost as {
        id: string;
        controllerId: string;
        defaultSessionId: string | null;
        hasDefaultWorkspace: boolean;
      };
      const workspaces = await gql(WORKSPACES, undefined, token);
      const scoped = workspaces.data.workspaces.filter(
        (workspace: { controllerId: string }) => workspace.controllerId === host.controllerId,
      );

      // 清理：先停后删，避免残留活跃云电脑
      await gql(STOP, { id: host.id, force: true }, token);
      await gql(DELETE, { id: host.id }, token);
      return { host, scoped };
    };

    // 默认工作区只在「Git 项目设置」初始化 Github 项目时创建
    const omitted = await createAndInspect({});
    expect(omitted.host.hasDefaultWorkspace).toBe(false);
    expect(omitted.host.defaultSessionId).toBeNull();
    expect(omitted.scoped).toEqual([]);

    const explicitEmpty = await createAndInspect({ workloadIds: [] });
    expect(explicitEmpty.host.hasDefaultWorkspace).toBe(false);
    expect(explicitEmpty.host.defaultSessionId).toBeNull();
    expect(explicitEmpty.scoped).toEqual([]);
  });

  it.skipIf(!HAS_MONGO)('R2-11: soft delete keeps DB archive row (cloudhosts.deletedAt + controllers row)', async () => {
    const db = (await mongoDb())!;
    const token = await fundedUserToken();
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
    const token = await fundedUserToken();
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
      const { token, userId } = await newFrontUser();
      const hostId = new mongoose.Types.ObjectId();
      const controllerId = new mongoose.Types.ObjectId();
      const now = new Date();
      try {
        await db.collection('cloudhosts').insertOne({
          _id: hostId,
          userId: new mongoose.Types.ObjectId(userId),
          tenantId: new mongoose.Types.ObjectId(userId),
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
          tenantId: new mongoose.Types.ObjectId(userId),
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
    const { token, userId } = await newFrontUser();
    const controllerId = new mongoose.Types.ObjectId();
    const now = new Date();
    try {
      await db.collection('controllers').insertOne({
        _id: controllerId,
        userId: new mongoose.Types.ObjectId(userId),
        tenantId: new mongoose.Types.ObjectId(userId),
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

  describe('创建期 workloadIds（T-CH-API-W1..W4）', () => {
    it('T-CH-API-W3: 超过 5 个 ID 报 too many workloads', async () => {
      const token = await newUserToken();
      const ids = Array.from(
        { length: 6 },
        () => new mongoose.Types.ObjectId().toString(),
      );
      const result = await gql(
        CREATE,
        { input: { name: 'wl-too-many', harnessTypes: ['OPENCODE'], workloadIds: ids } },
        token,
      );
      expect(result.errors?.[0].message).toBe('too many workloads (max 5)');
    });

    it('T-CH-API-W4: 不存在 ID 报 invalid workload', async () => {
      const token = await newUserToken();
      const missing = new mongoose.Types.ObjectId().toString();
      const result = await gql(
        CREATE,
        { input: { name: 'wl-missing', harnessTypes: ['OPENCODE'], workloadIds: [missing] } },
        token,
      );
      expect(result.errors?.[0].message).toBe(`invalid workload: ${missing}`);
    });

    it.skipIf(!HAS_MONGO)('T-CH-API-W2/W4: Docker 可创建，harness ID 拒绝', async () => {
      const db = (await mongoDb())!;
      const standard = await db
        .collection('cloudworkloads')
        .findOne({ workloadKind: 'standard', name: 'Docker' });
      const harness = await db
        .collection('cloudworkloads')
        .findOne({ workloadKind: 'harness' });
      expect(standard).toBeTruthy();
      expect(harness).toBeTruthy();

      const harnessToken = await newUserToken();
      const harnessResult = await gql(
        CREATE,
        {
          input: {
            name: 'wl-harness',
            harnessTypes: ['OPENCODE'],
            workloadIds: [String(harness!._id)],
          },
        },
        harnessToken,
      );
      expect(harnessResult.errors?.[0].message).toBe(
        `workload is not installable: ${String(harness!.name)}`,
      );

      const token = await fundedUserToken();
      const created = await gql(
        CREATE,
        {
          input: {
            name: `wl-docker-${Date.now().toString(36)}`,
            harnessTypes: ['OPENCODE'],
            workloadIds: [String(standard!._id)],
          },
        },
        token,
      );
      expect(created.errors).toBeUndefined();
      const hostId = created.data.createCloudHost.id as string;
      try {
        await gql(STOP, { id: hostId, force: true }, token);
        await gql(DELETE, { id: hostId }, token);
      } finally {
        // 清理失败不影响断言（容器可能在 STARTING 无法停止）
      }
    });
  });
});

// Kimi Code（Harness）：创建校验 + 逐容器 2.10.0 版本门禁（T-CH-API-K1）
describe.skipIf(!HARNESS_ENABLED)('Cloud Host API: KIMI_CODE harness', () => {
  it('T-CH-API-K1: accepts KIMI_CODE (multi-select) and stores agentGearMinVersion=2.10.0', async () => {
    const token = await fundedUserToken();
    const created = await gql(
      CREATE,
      {
        input: {
          name: `kimi-${Date.now().toString(36)}`,
          harnessTypes: ['OPENCODE', 'KIMI_CODE'],
        },
      },
      token,
    );
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    const host = created.data.createCloudHost;
    expect(host.harnessTypes).toEqual(['OPENCODE', 'KIMI_CODE']);

    try {
      if (!HAS_MONGO) return;
      const db = (await mongoDb())!;
      let doc: any = null;
      for (let i = 0; i < 20; i += 1) {
        doc = await db.collection('cloudcontainers').findOne({ hostId: host.id });
        if (doc) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(doc, 'cloud-controller should persist the container').toBeTruthy();
      expect(doc.harnessTypes).toEqual(['opencode', 'kimi_code']);
      expect(doc.agentGearMinVersion).toBe('2.10.0');
    } finally {
      await gql(STOP, { id: host.id, force: true }, token);
      await gql(DELETE, { id: host.id }, token);
    }
  });
});

// DeepSeek Harness（Harness）：创建校验 + 逐容器 2.11.0 版本门禁（T-DS-API2/3）
describe.skipIf(!HARNESS_ENABLED)('Cloud Host API: DEEPSEEK_HARNESS harness', () => {
  it('T-DS-API2/T-DS-API3: accepts DEEPSEEK_HARNESS (single & multi) and stores agentGearMinVersion=2.11.0', async () => {
    const token = await fundedUserToken();
    const created = await gql(
      CREATE,
      {
        input: {
          name: `deepseek-${Date.now().toString(36)}`,
          harnessTypes: ['OPENCODE', 'DEEPSEEK_HARNESS'],
        },
      },
      token,
    );
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    const host = created.data.createCloudHost;
    expect(host.harnessTypes).toEqual(['OPENCODE', 'DEEPSEEK_HARNESS']);

    try {
      if (!HAS_MONGO) return;
      const db = (await mongoDb())!;
      let doc: any = null;
      for (let i = 0; i < 20; i += 1) {
        doc = await db.collection('cloudcontainers').findOne({ hostId: host.id });
        if (doc) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(doc, 'cloud-controller should persist the container').toBeTruthy();
      expect(doc.harnessTypes).toEqual(['opencode', 'deepseek_harness']);
      expect(doc.agentGearMinVersion).toBe('2.11.0');
    } finally {
      await gql(STOP, { id: host.id, force: true }, token);
      await gql(DELETE, { id: host.id }, token);
    }
  });

  it('T-DS-API2b: unsupported harness type 文案不变', async () => {
    const token = await newUserToken();
    const result = await gql(
      CREATE,
      { input: { name: `bad-${Date.now().toString(36)}`, harnessTypes: ['FOO'] } },
      token,
    );
    // GraphQL 枚举校验会在 resolver 前拒绝非法 HarnessType（服务层文案仅在枚举外类型可达时出现）
    expect(result.errors?.[0].message).toMatch(
      /unsupported harness type: FOO|does not exist in "HarnessType" enum/,
    );
  });
});

// Phase 9：云电脑创建/查询/项目准备新增开关的 API 契约
const CLOUD_HOST = `
  query CloudHost($id: ID!) {
    cloudHost(id: $id) {
      id name controllerId status harnessTypes defaultSessionId activeSessionCount
    }
  }
`;

const SETUP_GITHUB = `
  mutation SetupGithub($input: SetupCloudHostGithubProjectInput!) {
    setupCloudHostGithubProject(input: $input) {
      id kind status steps { key status detail } sessionId error
    }
  }
`;

describe.skipIf(!HARNESS_ENABLED || !HAS_MONGO)('Cloud Host API: createDefaultSession / cloudHost(id) / createSession', () => {
  async function seedRunningHost(userId: string) {
    const db = (await mongoDb())!;
    const controllerId = new mongoose.Types.ObjectId();
    const hostId = new mongoose.Types.ObjectId();
    const workspaceId = new mongoose.Types.ObjectId();
    const keyId = new mongoose.Types.ObjectId();
    const now = new Date();
    await db.collection('controllers').insertOne({
      _id: controllerId,
      userId: new mongoose.Types.ObjectId(userId),
      tenantId: new mongoose.Types.ObjectId(userId),
      name: `phase9-${hostId.toString()}`,
      hostname: `phase9-${hostId.toString()}`,
      type: 'cloud',
      status: 'online',
      keyId,
      version: '2.6.0',
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
      name: `phase9-${hostId.toString()}`,
      harnessTypes: ['OPENCODE'],
      status: 'RUNNING',
      controllerId,
      keyId,
      workspaceId,
      containerId: new mongoose.Types.ObjectId().toString(),
      defaultSessionId: null,
      startedAt: now,
      readyAt: now,
      stoppedAt: null,
      failureReason: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    return {
      db,
      controllerId: controllerId.toString(),
      hostId: hostId.toString(),
      cleanup: async () => {
        await db.collection('cloud_host_setup_operations').deleteMany({ controllerId });
        await db.collection('cloud_host_github_bindings').deleteMany({ controllerId });
        await db.collection('sessions').deleteMany({ controllerId });
        await db.collection('cloudhosts').deleteOne({ _id: hostId });
        await db.collection('controllerworkspaces').deleteOne({ _id: workspaceId });
        await db.collection('controllers').deleteOne({ _id: controllerId });
      },
    };
  }

  async function seedGithubAccount(userId: string) {
    const db = (await mongoDb())!;
    const accountId = new mongoose.Types.ObjectId();
    await db.collection('githubaccounts').insertOne({
      _id: accountId,
      userId,
      tenantId: userId,
      githubUserId: Date.now(),
      githubLogin: 'phase9-owner',
      accessToken: 'encrypted-token',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('githubinstallations').insertOne({
      _id: new mongoose.Types.ObjectId(),
      accountId,
      installationId: Date.now(),
      accountLogin: 'phase9-owner',
      accountType: 'User',
      repos: [
        {
          repoId: 1,
          repoName: 'repo',
          fullName: 'phase9-owner/repo',
          private: false,
          permissions: { read: true, write: true },
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return {
      accountId: accountId.toString(),
      cleanup: async () => {
        await db.collection('githubinstallations').deleteOne({ accountId });
        await db.collection('githubaccounts').deleteOne({ _id: accountId });
      },
    };
  }

  it('T-CH-API-CDS1: createDefaultSession=false 落库，缺省保持 true', async () => {
    const db = (await mongoDb())!;
    const token = await fundedUserToken();
    const created = await gql(
      CREATE,
      {
        input: {
          name: `cds-${Date.now().toString(36)}`,
          harnessTypes: ['OPENCODE'],
          createDefaultSession: false,
        },
      },
      token,
    );
    expect(created.errors).toBeUndefined();
    const host = created.data.createCloudHost;
    try {
      const doc = await db.collection('cloudhosts').findOne({
        _id: new mongoose.Types.ObjectId(host.id),
      });
      expect(doc?.createDefaultSession).toBe(false);

      const legacyToken = await fundedUserToken();
      const legacy = await gql(
        CREATE,
        {
          input: {
            name: `cds-default-${Date.now().toString(36)}`,
            harnessTypes: ['OPENCODE'],
          },
        },
        legacyToken,
      );
      expect(legacy.errors).toBeUndefined();
      const legacyHost = legacy.data.createCloudHost;
      const legacyDoc = await db.collection('cloudhosts').findOne({
        _id: new mongoose.Types.ObjectId(legacyHost.id),
      });
      expect(legacyDoc?.createDefaultSession).toBe(true);

      await gql(STOP, { id: legacyHost.id, force: true }, legacyToken);
      await gql(DELETE, { id: legacyHost.id }, legacyToken);
    } finally {
      await gql(STOP, { id: host.id, force: true }, token);
      await gql(DELETE, { id: host.id }, token);
    }
  });

  it('T-CH-API-CHID1: cloudHost(id) 返回本人云电脑，他人/非法 ID 返回 null', async () => {
    const { token, userId } = await newFrontUser();
    const other = await newUserToken();
    const seeded = await seedRunningHost(userId);
    try {
      const own = await gql(CLOUD_HOST, { id: seeded.hostId }, token);
      expect(own.errors).toBeUndefined();
      expect(own.data.cloudHost).toMatchObject({
        id: seeded.hostId,
        controllerId: seeded.controllerId,
        status: 'RUNNING',
      });

      const foreign = await gql(CLOUD_HOST, { id: seeded.hostId }, other);
      expect(foreign.errors).toBeUndefined();
      expect(foreign.data.cloudHost).toBeNull();

      const missing = await gql(CLOUD_HOST, { id: '000000000000000000000000' }, token);
      expect(missing.errors).toBeUndefined();
      expect(missing.data.cloudHost).toBeNull();

      const malformed = await gql(CLOUD_HOST, { id: 'not-an-id' }, token);
      expect(malformed.errors).toBeUndefined();
      expect(malformed.data.cloudHost).toBeNull();
    } finally {
      await seeded.cleanup();
    }
  });

  // 计划 Phase 5 原拟在 CS1 中断言「全流程后 controllerWorkspaces 出现 finalPath 工作区、
  // myCloudHosts.hasDefaultWorkspace=true、无默认会话」。该断言需真实 K8s 容器完成 clone，
  // 本地 API 环境 runner 在 workload 步即失败、不可达；等价行为由单测 T-CHG9 覆盖，
  // 全流程工作区断言由单测 T-CHG9 + 验收环境 E2E-1 覆盖。
  it('T-CH-API-CS1: createSession=false 时 session 步骤初始化为 SKIPPED', async () => {
    const { token, userId } = await newFrontUser();
    const seeded = await seedRunningHost(userId);
    const github = await seedGithubAccount(userId);
    try {
      const result = await gql(
        SETUP_GITHUB,
        {
          input: {
            controllerId: seeded.controllerId,
            accountId: github.accountId,
            repoFullName: 'phase9-owner/repo',
            targetPath: '/home/worker/workspace',
            createSession: false,
          },
        },
        token,
      );
      expect(result.errors).toBeUndefined();
      const steps = result.data.setupCloudHostGithubProject.steps as Array<{
        key: string;
        status: string;
        detail: string | null;
      }>;
      expect(steps.find((step) => step.key === 'session')).toMatchObject({
        status: 'SKIPPED',
        detail: '多 Harness 不自动创建会话',
      });
    } finally {
      await github.cleanup();
      await seeded.cleanup();
    }
  });

  it('T-CH-API-WS1: targetPath=~/workspace 服务端归一落库为绝对路径（createSession=false 仍 SKIPPED）', async () => {
    const { token, userId } = await newFrontUser();
    const seeded = await seedRunningHost(userId);
    const github = await seedGithubAccount(userId);
    try {
      const result = await gql(
        SETUP_GITHUB,
        {
          input: {
            controllerId: seeded.controllerId,
            accountId: github.accountId,
            repoFullName: 'phase9-owner/repo',
            targetPath: '~/workspace',
            createSession: false,
          },
        },
        token,
      );
      expect(result.errors).toBeUndefined();
      const steps = result.data.setupCloudHostGithubProject.steps as Array<{
        key: string;
        status: string;
        detail: string | null;
      }>;
      expect(steps.find((step) => step.key === 'gitSetup')).toMatchObject({
        status: 'PENDING',
        detail: null,
      });
      expect(steps.find((step) => step.key === 'session')).toMatchObject({
        status: 'SKIPPED',
        detail: '多 Harness 不自动创建会话',
      });

      // operation 在 createOperation 内同步落库：直连断言服务端把 '~/workspace' 归一为
      // /home/worker/workspace 并与 owner/repo 权威拼接后的 targetPath。
      // binding / 工作区（controllerWorkspaces、CloudHost.workspaceId）的最终路径断言依赖
      // 真实容器 clone 成功；本地 runner 在 workload 步即失败、不可达，由单测 T-CHG9/T-CHG10
      // 与验收环境 E2E-1 覆盖。
      const operationId = result.data.setupCloudHostGithubProject.id as string;
      const storedOperation = await seeded.db
        .collection('cloud_host_setup_operations')
        .findOne({ _id: new mongoose.Types.ObjectId(operationId) });
      expect(storedOperation?.targetPath).toBe('/home/worker/workspace/phase9-owner/repo');
    } finally {
      await github.cleanup();
      await seeded.cleanup();
    }
  });

  it('T-CH-API-CS2: 缺省 createSession 保持 PENDING（单 Harness 旧行为）', async () => {
    const { token, userId } = await newFrontUser();
    const seeded = await seedRunningHost(userId);
    const github = await seedGithubAccount(userId);
    try {
      const result = await gql(
        SETUP_GITHUB,
        {
          input: {
            controllerId: seeded.controllerId,
            accountId: github.accountId,
            repoFullName: 'phase9-owner/repo',
            targetPath: '/home/worker/workspace',
          },
        },
        token,
      );
      expect(result.errors).toBeUndefined();
      const steps = result.data.setupCloudHostGithubProject.steps as Array<{
        key: string;
        status: string;
      }>;
      expect(steps.find((step) => step.key === 'session')?.status).toBe('PENDING');
    } finally {
      await github.cleanup();
      await seeded.cleanup();
    }
  });
});
