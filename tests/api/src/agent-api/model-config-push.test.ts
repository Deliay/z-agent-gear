import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { startMockServer, type MockServer } from '../mock-server.js';
import { createFrontUser, agentApiBaseUrl } from '../support/front-users.js';

// 模型下发优化 #533（计划 §6.2 T-MCS-API3 / T-MCS-API4）。
//
// 前置：`aspire start && aspire wait agent-api cloud-controller` + `INTERNAL_API_TOKEN`（开户 / 内部端点）。
// `MONGODB_URI` 用于断言「该租户无 RUNNING 云电脑」（T-MCS-API3 的零请求前提），缺省时跳过该分支。
//
// 为什么不断言「本地 HTTP 桩收到的 POST /internal/containers/:id/harness-models」：
// agent-api 的 `CLOUD_CONTROLLER_URL` 是**进程级配置**（Aspire 注入），测试进程无法在运行期改成
// 指向进程内桩；因此本套件改为两层最小可靠断言：
// 1) 前台/供应商 mutation 在触发推送后仍正常返回（fire-and-forget 不阻塞、不破坏返回）；
// 2) 目标内部端点的契约守卫（Bearer 401 / 未知容器 404 `NOT_FOUND`）——与 agent-api
//    `CloudControllerClient.pushHarnessModels` 的调用形态逐字一致；
// 3) 载荷分组 / 显示名 / vendorId、并发闸门与单台失败隔离由单测覆盖
//    （`servers/agent-api/src/services/{model-provision,cloud-host-model-push}.test.ts`）。

const GRAPHQL_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const AGENT_API_BASE = agentApiBaseUrl();
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
const CLOUD_CONTROLLER_BASE = process.env.CLOUD_CONTROLLER_URL || 'http://localhost:10004';
const CLOUD_CONTROLLER_TOKEN = process.env.CLOUD_CONTROLLER_INTERNAL_TOKEN;
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

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

const CREATE_PROVIDER = `
  mutation CreateProvider($input: ProviderInput!) {
    createProvider(input: $input) {
      id name scope
      models { id name isEnabled }
    }
  }
`;
const DELETE_PROVIDER = `mutation($id: ID!) { deleteProvider(id: $id) }`;
const TOGGLE_PROVIDER = `
  mutation($id: ID!) { toggleProvider(id: $id) { id isEnabled } }
`;
const CREATE_CUSTOM_MODEL = `
  mutation CreateCustomModel($input: CustomModelInput!) {
    createCustomModel(input: $input) { id name contextLength isCustom }
  }
`;
const DELETE_CUSTOM_MODEL = `
  mutation($id: ID!) { deleteCustomModel(id: $id) { id } }
`;
const TOGGLE_MODEL = `
  mutation($id: ID!) { toggleModel(id: $id) { id isEnabled } }
`;
const UPDATE_MODEL_CONTEXT_LENGTH = `
  mutation($modelId: ID!, $contextLength: Int) {
    updateModelContextLength(modelId: $modelId, contextLength: $contextLength) {
      id contextLength
    }
  }
`;

describe('T-MCS-API3 前台模型/供应商变更触发的实时下发（best-effort）', () => {
  let mock: MockServer;
  let tenantId = '';
  let token = '';
  let providerId = '';
  let modelId = '';
  const modelName = `push-model-${Date.now()}`;

  beforeAll(async () => {
    mock = await startMockServer([{ id: modelName, contextLength: 128_000 }]);
    const frontUser = await createFrontUser();
    token = frontUser.token;
    tenantId = frontUser.tenantId;

    const created = await gql(
      CREATE_PROVIDER,
      {
        input: {
          name: `push-provider-${Date.now()}`,
          type: 'OpenAI',
          endpoint: `http://127.0.0.1:${mock.port}/v1`,
          credentialType: 'api_key',
          credentialValue: 'sk-test-fake-key',
        },
      },
      token,
    );
    expect(created.errors).toBeUndefined();
    providerId = created.data.createProvider.id as string;
    modelId = created.data.createProvider.models.find(
      (model: { name: string }) => model.name === modelName,
    )?.id as string;
    expect(modelId).toBeTruthy();
  });

  afterAll(async () => {
    if (providerId) await gql(DELETE_PROVIDER, { id: providerId }, token);
    await mock?.close();
  });

  it('无 RUNNING 云电脑时 toggleModel 正常返回（推送不阻塞、不破坏返回）', async () => {
    if (HAS_MONGO) {
      const db = (await mongoDb())!;
      // 独立开户 → 该租户下没有任何 RUNNING 云电脑：推送扇出候选为空（零候选 = 零请求）。
      const running = await db.collection('cloudhosts').countDocuments({
        tenantId: new mongoose.Types.ObjectId(tenantId),
        status: 'RUNNING',
        deletedAt: null,
      });
      expect(running, '新开户租户不应有 RUNNING 云电脑').toBe(0);
    }

    const disabled = await gql(TOGGLE_MODEL, { id: modelId }, token);
    expect(disabled.errors).toBeUndefined();
    expect(disabled.data.toggleModel.isEnabled).toBe(false);

    const enabled = await gql(TOGGLE_MODEL, { id: modelId }, token);
    expect(enabled.errors).toBeUndefined();
    expect(enabled.data.toggleModel.isEnabled).toBe(true);
  });

  it('无 RUNNING 云电脑时 updateModelContextLength / createCustomModel / deleteCustomModel 正常返回', async () => {
    const updated = await gql(
      UPDATE_MODEL_CONTEXT_LENGTH,
      { modelId, contextLength: 8192 },
      token,
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data.updateModelContextLength.contextLength).toBe(8192);

    const custom = await gql(
      CREATE_CUSTOM_MODEL,
      { input: { providerId, name: `push-custom-${Date.now()}`, contextLength: 4096 } },
      token,
    );
    expect(custom.errors).toBeUndefined();
    expect(custom.data.createCustomModel.contextLength).toBe(4096);

    const removed = await gql(DELETE_CUSTOM_MODEL, { id: custom.data.createCustomModel.id }, token);
    expect(removed.errors).toBeUndefined();
    expect(removed.data.deleteCustomModel.id).toBe(custom.data.createCustomModel.id);
  });

  it('无 RUNNING 云电脑时 toggleProvider 正常返回（供应商 mutation 同层触发）', async () => {
    const disabled = await gql(TOGGLE_PROVIDER, { id: providerId }, token);
    expect(disabled.errors).toBeUndefined();
    expect(disabled.data.toggleProvider.isEnabled).toBe(false);

    const enabled = await gql(TOGGLE_PROVIDER, { id: providerId }, token);
    expect(enabled.errors).toBeUndefined();
    expect(enabled.data.toggleProvider.isEnabled).toBe(true);
  });

  // 目标端点契约守卫：agent-api `pushHarnessModels` 即向该路径 POST `{ provision }`。
  // 载荷分组/显示名/vendorId 断言见 `services/cloud-host-model-push.test.ts`（T-CP1~3）与
  // `services/model-provision.test.ts`（T-MP1~6）。
  it.skipIf(!CLOUD_CONTROLLER_TOKEN)(
    '内部下发端点契约守卫：缺 Bearer 401 / 未知容器 404 NOT_FOUND',
    async () => {
      const containerId = new mongoose.Types.ObjectId().toString();
      const provision = {
        providers: [
          { vendorId: 'zag', displayName: 'Agent Gear', models: [{ id: modelName }] },
        ],
      };

      const noAuth = await fetch(
        `${CLOUD_CONTROLLER_BASE}/internal/containers/${containerId}/harness-models`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provision }),
        },
      );
      expect(noAuth.status).toBe(401);

      const unknown = await fetch(
        `${CLOUD_CONTROLLER_BASE}/internal/containers/${containerId}/harness-models`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${CLOUD_CONTROLLER_TOKEN}`,
          },
          body: JSON.stringify({ provision }),
        },
      );
      expect(unknown.status).toBe(404);
      await expect(unknown.json()).resolves.toMatchObject({ error: 'NOT_FOUND' });
    },
  );
});

describe('T-MCS-API4 agent-api 内部全局模型刷新端点', () => {
  function refreshRequest(body: unknown, token?: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${AGENT_API_BASE}/internal/model-config/refresh`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('无 token / 错 token → 401 UNAUTHORIZED', async () => {
    const missing = await refreshRequest({ scope: 'global' });
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({ error: 'UNAUTHORIZED' });

    const wrong = await refreshRequest({ scope: 'global' }, 'nope');
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it.skipIf(!INTERNAL_API_TOKEN)('scope 非 global → 400 INVALID_SCOPE', async () => {
    for (const body of [{ scope: 'user' }, {}, { scope: null }]) {
      const res = await refreshRequest(body, INTERNAL_API_TOKEN);
      expect(res.status, JSON.stringify(body)).toBe(400);
      await expect(res.json(), JSON.stringify(body)).resolves.toMatchObject({
        error: 'INVALID_SCOPE',
      });
    }
  });

  it.skipIf(!INTERNAL_API_TOKEN)('合法请求 → 202 { accepted: true }，重复调用幂等', async () => {
    const first = await refreshRequest({ scope: 'global' }, INTERNAL_API_TOKEN);
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({ accepted: true });

    // 重复触发由进程内 single-flight 合并，仍以 202 受理（幂等受理语义）。
    const second = await refreshRequest({ scope: 'global' }, INTERNAL_API_TOKEN);
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toMatchObject({ accepted: true });
  });
});
