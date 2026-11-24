import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { ContainerService } from '../services/container-service.js';
import { InMemoryK8sClient } from '../services/k8s-client.js';
import { K8sJobManager } from '../services/k8s-job-manager.js';
import { TokenService } from '../services/token-service.js';
import { InMemoryContainerRepository } from '../repositories/container-repository.js';
import { InMemoryWorkloadRepository } from '../repositories/workload-repository.js';
import { InMemoryWorkloadLogRepository } from '../repositories/workload-log-repository.js';
import { internalAuth } from '../middleware/internal-auth.js';
import { logger as rootLogger } from '../observability/logger.js';
import { createTestLogger } from '../observability/testing.js';

/**
 * 注入 createTestLogger：在被测模块加载前拦截 `rootLogger.child(...)`，把 internal-api
 * 的告警日志写入内存 sink，断言 `records` 的结构化字段（`msg`/`component`/`tenantId` 等）。
 */
const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const { createInternalRouter, parseHarnessRequest } = await import('./internal-api.js');
childSpy.mockRestore();

const INTERNAL_TOKEN = 'test-internal-token';

let httpServer: HttpServer;
let baseUrl: string;
let repo: InMemoryContainerRepository;
let k8sClient: InMemoryK8sClient;
let containerService: ContainerService;
let workloadLogRepository: InMemoryWorkloadLogRepository;
let workloadRepository: InMemoryWorkloadRepository;
let stubWorkspaceResolver: ReturnType<typeof vi.fn>;
/** runtime harness 版本门禁用：在线 worker 版本读取（可按用例改返回值）。 */
let getWorkerVersion: ReturnType<typeof vi.fn>;
/** 升级端点用桩：gateway 句柄（在飞/回执结果由用例驱动）。 */
let requestAgentGearUpgrade: ReturnType<typeof vi.fn>;
/** runtime 路由用桩 dispatcher（不执行真实编排，仅断言入参/门禁）。 */
let runtimeDispatcher: { startRuntimeBatch: ReturnType<typeof vi.fn> };
/** 运行期模型下发（A.2.15）用桩：gateway 未注入的 503 用例走 `/internal` 路由。 */
let requestHarnessModelsStub: ReturnType<typeof vi.fn>;
let pushWorkerVersion: ReturnType<typeof vi.fn>;
/** A.2.15 端点用例：受控容器状态与 secret 存在性（真实 repo 的 ID 为 UUID，不满足 ObjectId 口径）。 */
let pushContainers: Map<string, { status: string; hasSecret: boolean }>;
let pushUpdateModelProvision: ReturnType<typeof vi.fn>;
let pushSeq: number;

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${INTERNAL_TOKEN}`, ...extra };
}

async function createContainer(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/internal/containers`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

/** 注入全局工作区解析器的路由（多租户二期 workspaceId 回退用例，免真库）。 */
async function createStubContainer(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/stub/containers`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

/** 以合法 ObjectId 容器 ID 发起 runtime 安装（桩 dispatcher 不校验容器存在）。 */
const RUNTIME_GATE_CONTAINER_ID = '507f1f77bcf86cd799439099';

async function startRuntimeOnOnlineContainer(workloadId: string): Promise<Response> {
  return fetch(`${baseUrl}/gate/containers/${RUNTIME_GATE_CONTAINER_ID}/workloads`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ workloadId, source: 'user' }),
  });
}

/** harness 最小合法请求体（多租户二期 workspaceId 用例复用）。 */
function harnessPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    purpose: 'harness',
    hostId: 'host-ws',
    refId: 'ck-ws',
    userId: 'user-ws',
    tenantId: 'tenant-ws',
    hostName: 'pc-ws',
    harnessTypes: ['opencode'],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    agentGearMinVersion: '2.10.0',
    secrets: {
      hostEndpoint: 'wss://controller.example.com',
      hostKey: 'zag_k_1_ws',
      modelApiKey: 'zag_sk_ws',
      modelBaseUrl: 'http://admin-api:8002/v1',
      modelIds: '["a"]',
      defaultWorkspace: '/home/worker/workspace',
    },
    workloadPlan: [{ workloadId: 'wl-a', params: {}, implicit: false, required: true }],
    ...overrides,
  };
}

beforeAll(async () => {
  repo = new InMemoryContainerRepository();
  const client = new InMemoryK8sClient();
  k8sClient = client;
  const tokenService = new TokenService(repo);
  const jobManager = new K8sJobManager(client, {
    namespace: 'zag-workers',
    image: 'zero-tools/zag-worker:latest',
    runtimeClassName: 'sysbox-runc',
    publicWsEndpoint: 'cloud.example.com:4003',
  });
  const service = new ContainerService(
    repo,
    tokenService,
    jobManager,
    {
      namespace: 'zag-workers',
      image: 'zero-tools/zag-worker:latest',
      connectTimeoutMs: 300000,
      shutdownGraceMs: 0,
    },
    testLog.logger,
  );
  containerService = service;

  workloadRepository = new InMemoryWorkloadRepository();
  for (const id of ['wl-a', 'wl-b', 'wl-c']) {
    workloadRepository.add({
      id,
      name: `workload-${id}`,
      initScript: `echo ${id}`,
      postScript: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  // 依赖展开兜底用例的夹具：wl-dep 依赖 wl-base 且带默认参数。
  workloadRepository.add({
    id: 'wl-base',
    name: 'workload-wl-base',
    initScript: 'echo base',
    postScript: null,
    paramSchema: [],
    dependsOnWorkloadIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  workloadRepository.add({
    id: 'wl-dep',
    name: 'workload-wl-dep',
    initScript: 'echo dep',
    postScript: null,
    paramSchema: [
      { key: 'version', label: '版本', type: 'text', options: [], defaultValue: '22' },
    ],
    dependsOnWorkloadIds: ['wl-base'],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 兜底展开失败用例：依赖环 / 依赖缺失 / 展开超 10 / 非法默认值。
  const addWorkload = (id: string, dependsOnWorkloadIds: string[] = []) =>
    workloadRepository.add({
      id,
      name: `workload-${id}`,
      initScript: `echo ${id}`,
      postScript: null,
      paramSchema: [],
      dependsOnWorkloadIds,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  addWorkload('wl-cyc-a', ['wl-cyc-b']);
  addWorkload('wl-cyc-b', ['wl-cyc-a']);
  addWorkload('wl-orphan', ['wl-ghost']);
  const bigDeps = Array.from({ length: 10 }, (_, i) => `wl-big-dep-${i}`);
  bigDeps.forEach((id) => addWorkload(id));
  addWorkload('wl-big', bigDeps);
  workloadRepository.add({
    id: 'wl-bad-default',
    name: 'workload-wl-bad-default',
    initScript: 'echo bad',
    postScript: null,
    paramSchema: [
      { key: 'mode', label: '模式', type: 'select', options: ['a'], defaultValue: 'z' },
    ],
    dependsOnWorkloadIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // runtime 安装 harness 负载的版本门禁用例（workloadId 须为 ObjectId）。
  workloadRepository.add({
    id: '507f1f77bcf86cd7994390a2',
    name: 'workload-standard-gate',
    initScript: 'echo standard',
    postScript: null,
    workloadKind: 'standard',
    harnessType: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  workloadRepository.add({
    id: '507f1f77bcf86cd7994390a1',
    name: 'DeepSeek Harness（Harness）',
    initScript: 'echo harness',
    postScript: null,
    workloadKind: 'harness',
    harnessType: 'deepseek_harness',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  workloadLogRepository = new InMemoryWorkloadLogRepository();

  const app = express();
  app.use(express.json());
  app.use(
    '/internal',
    internalAuth(INTERNAL_TOKEN),
    createInternalRouter(service, { workloadRepository, workloadLogRepository }),
  );
  // 多租户二期：workspaceId 缺失回退解析器注入（真库不可用时的确定性用例）。
  stubWorkspaceResolver = vi.fn();
  app.use(
    '/stub',
    internalAuth(INTERNAL_TOKEN),
    createInternalRouter(service, {
      workloadRepository,
      workloadLogRepository,
      resolveGlobalWorkspaceId: stubWorkspaceResolver,
    }),
  );
  // runtime 安装路由（harness 负载）门禁用例：桩 dispatcher + 可注入 worker 版本。
  getWorkerVersion = vi.fn();
  runtimeDispatcher = { startRuntimeBatch: vi.fn() };
  runtimeDispatcher.startRuntimeBatch.mockResolvedValue({
    batchId: 'runtime-test',
    items: [
      {
        logId: 'log-1',
        workloadId: '507f1f77bcf86cd7994390a1',
        workloadName: 'DeepSeek Harness（Harness）',
      },
    ],
  });
  app.use(
    '/gate',
    internalAuth(INTERNAL_TOKEN),
    createInternalRouter(service, {
      workloadRepository,
      workloadLogRepository,
      workloadDispatcher: runtimeDispatcher as never,
      getWorkerVersion,
    }),
  );
  // 运行期模型下发（A.2.15）：注入 gateway 桩与 worker 版本读取。
  // 容器读取/secret 写入用受控桩（真实 repo 的 ID 为 UUID，端点按 ObjectId 口径判 404）。
  requestHarnessModelsStub = vi.fn();
  requestHarnessModelsStub.mockResolvedValue({
    delivered: true,
    appliedTypes: ['opencode'],
  });
  pushWorkerVersion = vi.fn();
  pushWorkerVersion.mockReturnValue('2.20.0');
  pushContainers = new Map();
  pushSeq = 0;
  pushUpdateModelProvision = vi.fn(async (containerId: string) => {
    const container = pushContainers.get(containerId);
    if (!container || !container.hasSecret) return null;
    return {};
  });
  const pushContainerService = {
    get: async (containerId: string) => {
      const container = pushContainers.get(containerId);
      return container ? { id: containerId, status: container.status } : null;
    },
    updateModelProvision: pushUpdateModelProvision,
  };
  app.use(
    '/modelpush',
    internalAuth(INTERNAL_TOKEN),
    createInternalRouter(pushContainerService as never, {
      workloadRepository,
      workloadLogRepository,
      getWorkerVersion: pushWorkerVersion,
      requestHarnessModels: requestHarnessModelsStub as never,
    }),
  );

  requestAgentGearUpgrade = vi.fn();
  app.use(
    '/upgrade',
    internalAuth(INTERNAL_TOKEN),
    createInternalRouter(service, {
      workloadRepository,
      workloadLogRepository,
      getWorkerVersion,
      requestAgentGearUpgrade,
    }),
  );
  httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('internal management API', () => {
  it('T-R1: GET/POST/DELETE conform to the contract (exit code + body shape)', async () => {
    const empty = await fetch(`${baseUrl}/internal/containers`, { headers: authHeaders() });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    const created = await createContainer({ purpose: 'idle' });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        'agentGearVersion',
        'billingAccountId',
        'billingStartedAt',
        'installedWorkloads',
        'connectedAt',
        'containerApiKeyId',
        'controllerKeyId',
        'createdAt',
        'currentWorkloadName',
        'exitReason',
        'exitedAt',
        'expiresAt',
        'harnessTypes',
        'hostId',
        'hostName',
        'id',
        'image',
        'name',
        'namespace',
        'purpose',
        'refId',
        'status',
        'storageArchiveFailure',
        'storageArchiveFileName',
        'storageArchiveFinishedAt',
        'storageArchiveId',
        'storageArchiveSkipped',
        'storageArchiveStartedAt',
        'storageArchiveStatus',
        'storageArchiveUsageBytes',
        'storageId',
        'storagePvcName',
        'storageRestorePath',
        'storageSizeGi',
        'storageWorkspaceId',
        'userId',
        'workloadIds',
        'workloadPlan',
      ].sort(),
    );
    expect(body.status).toBe('connecting');
    expect(body.purpose).toBe('idle');
    expect(body.refId).toBeNull();
    expect(body.workloadIds).toEqual([]);
    expect(body.workloadPlan).toEqual([]);
    expect(body.currentWorkloadName).toBeNull();

    const list = await fetch(`${baseUrl}/internal/containers`, { headers: authHeaders() });
    const listBody = (await list.json()) as unknown[];
    expect(listBody.length).toBeGreaterThanOrEqual(1);

    const destroyed = await fetch(`${baseUrl}/internal/containers/${body.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(destroyed.status).toBe(200);
    // 契约 A.2.3：响应透出 deletedJob（问题 50）
    expect(await destroyed.json()).toEqual({ success: true, deletedJob: true });
  });

  it('T-R2/T-IC7: missing or invalid bearer token -> 401 (含 workload-logs)', async () => {
    const missing = await fetch(`${baseUrl}/internal/containers`);
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${baseUrl}/internal/containers`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(wrong.status).toBe(401);

    const logsMissing = await fetch(`${baseUrl}/internal/containers/whatever/workload-logs`);
    expect(logsMissing.status).toBe(401);
  });

  it('T-CC4: purpose 白名单仅 idle|harness；admin-task/workflow/session 仍 400', async () => {
    for (const purpose of ['admin-task', 'workflow', 'session']) {
      const res = await createContainer({ purpose });
      expect(res.status, purpose).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error, purpose).toBe('UNSUPPORTED_PURPOSE');
      expect(body.message, purpose).toBe('该任务类型暂未开放');
    }
  });

  it('T-R4: deleting an unknown container -> 404; terminal container -> idempotent success', async () => {
    const unknown = await fetch(`${baseUrl}/internal/containers/does-not-exist`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(unknown.status).toBe(404);

    const created = await createContainer({ purpose: 'idle' });
    const { id } = (await created.json()) as { id: string };

    const first = await fetch(`${baseUrl}/internal/containers/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(await first.json()).toEqual({ success: true, deletedJob: true });

    const second = await fetch(`${baseUrl}/internal/containers/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(second.status).toBe(200);
    // 幂等：Job 已不存在，deletedJob 反映本次未真实删除
    expect(await second.json()).toEqual({ success: true, deletedJob: false });
  });

  it('T-IC5: workloadIds 合法时落库并回显（去重保序）', async () => {
    const res = await createContainer({ purpose: 'idle', workloadIds: ['wl-b', 'wl-a', 'wl-b'] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workloadIds: string[] };
    expect(body.workloadIds).toEqual(['wl-b', 'wl-a']);
  });

  it('T-IC5b: workloadIds 非法 → 400 INVALID_WORKLOAD', async () => {
    const cases: Array<[string, unknown]> = [
      ['unknown id', ['wl-missing']],
      ['not an array', 'wl-a'],
      ['non-string element', [123]],
      ['empty string element', ['']],
      ['too many', Array.from({ length: 11 }, () => 'wl-a')],
    ];
    for (const [label, workloadIds] of cases) {
      const res = await createContainer({ purpose: 'idle', workloadIds });
      expect(res.status, label).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error, label).toBe('INVALID_WORKLOAD');
    }
  });

  it('T-IC6: GET workload-logs 按执行顺序返回；不存在容器 404；无记录 []', async () => {
    const created = await createContainer({ purpose: 'idle' });
    const { id } = (await created.json()) as { id: string };

    const before = await fetch(`${baseUrl}/internal/containers/${id}/workload-logs`, {
      headers: authHeaders(),
    });
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual([]);

    await workloadLogRepository.createMany([
      {
        containerId: id,
        workloadId: 'wl-a',
        workloadName: 'workload-wl-a',
        phase: 'init',
        status: 'success',
        script: 'echo a',
        exitCode: 0,
        log: 'a',
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        finishedAt: new Date('2026-01-01T00:00:01.000Z'),
      },
      {
        containerId: id,
        workloadId: 'wl-b',
        workloadName: 'workload-wl-b',
        phase: 'post',
        status: 'timeout',
        script: 'echo b',
        log: 'b',
      },
    ]);

    const res = await fetch(`${baseUrl}/internal/containers/${id}/workload-logs`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const logs = (await res.json()) as Array<Record<string, unknown>>;
    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.workloadId)).toEqual(['wl-a', 'wl-b']);
    expect(logs[0]).toMatchObject({
      containerId: id,
      phase: 'init',
      status: 'success',
      script: 'echo a',
      exitCode: 0,
      log: 'a',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    });
    expect(logs[1]!.startedAt).toBeNull();
    expect(typeof logs[0]!.createdAt).toBe('string');

    const missing = await fetch(`${baseUrl}/internal/containers/not-a-container/workload-logs`, {
      headers: authHeaders(),
    });
    expect(missing.status).toBe(404);
  });

  it('T-ICC1/T-CCS1: POST { workloadPlan } 合法 → 201 回显 plan；日志含 params 快照', async () => {
    const res = await createContainer({
      purpose: 'idle',
      workloadPlan: [
        { workloadId: 'wl-a', params: { version: '22' }, implicit: false },
        { workloadId: 'wl-base', params: {}, implicit: true },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      workloadIds: string[];
      workloadPlan: unknown;
    };
    expect(body.workloadPlan).toEqual([
      { workloadId: 'wl-a', params: { version: '22' }, implicit: false, required: false },
      { workloadId: 'wl-base', params: {}, implicit: true, required: false },
    ]);
    expect(body.workloadIds).toEqual(['wl-a', 'wl-base']);

    await workloadLogRepository.createMany([
      {
        containerId: body.id,
        workloadId: 'wl-a',
        workloadName: 'workload-wl-a',
        phase: 'init',
        status: 'success',
        script: 'echo a',
        params: { version: '22' },
      },
    ]);
    const logsRes = await fetch(`${baseUrl}/internal/containers/${body.id}/workload-logs`, {
      headers: authHeaders(),
    });
    const logs = (await logsRes.json()) as Array<Record<string, unknown>>;
    expect(logs[0]!.params).toEqual({ version: '22' });
  });

  it('T-ICC2: workloadPlan 非法 → 400 INVALID_WORKLOAD', async () => {
    const cases: Array<[string, unknown]> = [
      ['not an array', { workloadId: 'wl-a' }],
      ['unknown id', [{ workloadId: 'wl-missing', params: {}, implicit: false }]],
      [
        'duplicate workloadId',
        [
          { workloadId: 'wl-a', params: {}, implicit: false },
          { workloadId: 'wl-a', params: {}, implicit: true },
        ],
      ],
      ['params not an object', [{ workloadId: 'wl-a', params: 'x', implicit: false }]],
      ['implicit not boolean', [{ workloadId: 'wl-a', params: {}, implicit: 'no' }]],
      ['required not boolean', [{ workloadId: 'wl-a', params: {}, implicit: false, required: 'yes' }]],
      [
        'too many',
        Array.from({ length: 11 }, () => ({ workloadId: 'wl-a', params: {}, implicit: false })),
      ],
    ];
    for (const [label, workloadPlan] of cases) {
      const res = await createContainer({ purpose: 'idle', workloadPlan });
      expect(res.status, label).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error, label).toBe('INVALID_WORKLOAD');
    }
  });

  it('T-ICC3: 仅 workloadIds（旧客户端）→ 兜底展开执行，workloadIds 按选择顺序落库', async () => {
    const res = await createContainer({ purpose: 'idle', workloadIds: ['wl-dep'] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workloadIds: string[];
      workloadPlan: Array<{ workloadId: string; params: unknown; implicit: boolean }>;
    };

    // plan 用于执行：依赖先于依赖方、隐式依赖取默认参数
    expect(body.workloadPlan).toEqual([
      { workloadId: 'wl-base', params: {}, implicit: true, required: false },
      { workloadId: 'wl-dep', params: { version: '22' }, implicit: false, required: false },
    ]);
    // 契约 A.2.2：workloadIds 按选择顺序落库（不含隐式依赖）
    expect(body.workloadIds).toEqual(['wl-dep']);
  });

  it('T-ICC9: plan 条目缺省 params/implicit → 归一为 {}/false（不报错）', async () => {
    const res = await createContainer({
      purpose: 'idle',
      workloadPlan: [{ workloadId: 'wl-a' }, { workloadId: 'wl-b', params: { version: '22' } }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workloadPlan: unknown };
    expect(body.workloadPlan).toEqual([
      { workloadId: 'wl-a', params: {}, implicit: false, required: false },
      { workloadId: 'wl-b', params: { version: '22' }, implicit: false, required: false },
    ]);
  });

  it('T-ICC10: 兜底展开失败（环 / 依赖缺失 / 超 10 / 非法默认值）→ 400 INVALID_WORKLOAD', async () => {
    const cases: Array<[string, string[]]> = [
      ['dependency cycle', ['wl-cyc-a']],
      ['missing dependency', ['wl-orphan']],
      ['expanded > 10', ['wl-big']],
      ['invalid default', ['wl-bad-default']],
    ];
    for (const [label, workloadIds] of cases) {
      const res = await createContainer({ purpose: 'idle', workloadIds });
      expect(res.status, label).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error, label).toBe('INVALID_WORKLOAD');
    }
  });

  it('T-ICC11: 兜底展开错误文案与 admin-api 同口径（环仅含环路径、缺失无 id）', async () => {
    const cycle = await createContainer({ purpose: 'idle', workloadIds: ['wl-cyc-a'] });
    const cycleBody = (await cycle.json()) as { message: string };
    expect(cycleBody.message).toBe(
      'dependency cycle detected: wl-cyc-a -> wl-cyc-b -> wl-cyc-a',
    );

    const missing = await createContainer({ purpose: 'idle', workloadIds: ['wl-orphan'] });
    const missingBody = (await missing.json()) as { message: string };
    expect(missingBody.message).toBe('dependency workload not found: wl-ghost');
  });

  it('T-ICC4: workloadPlan 与 workloadIds 同时下发 → 以 plan 为准', async () => {
    const res = await createContainer({
      purpose: 'idle',
      workloadIds: ['wl-b'],
      workloadPlan: [{ workloadId: 'wl-a', params: {}, implicit: false }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workloadIds: string[]; workloadPlan: unknown };
    expect(body.workloadIds).toEqual(['wl-a']);
    expect(body.workloadPlan).toEqual([
      { workloadId: 'wl-a', params: {}, implicit: false, required: false },
    ]);
  });

  it('T-ICC7: workloadPlan[].required 合法/缺省/null → 归一 false；true 保留并回读', async () => {
    const res = await createContainer({
      purpose: 'idle',
      workloadPlan: [
        { workloadId: 'wl-a', params: {}, implicit: false, required: true },
        { workloadId: 'wl-b', params: {}, implicit: false },
        { workloadId: 'wl-dep', params: {}, implicit: false, required: null },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workloadPlan: unknown };
    expect(body.workloadPlan).toEqual([
      { workloadId: 'wl-a', params: {}, implicit: false, required: true },
      { workloadId: 'wl-b', params: {}, implicit: false, required: false },
      { workloadId: 'wl-dep', params: {}, implicit: false, required: false },
    ]);
  });

  it('T-ICC8: 仅 workloadIds 兜底展开 → plan 条目 required 一律 false', async () => {
    const res = await createContainer({ purpose: 'idle', workloadIds: ['wl-dep'] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workloadPlan: Array<{ required: boolean }>;
    };
    expect(body.workloadPlan.every((entry) => entry.required === false)).toBe(true);
  });

  it('T-CCS2: CloudWorkloadLog JSON 携带 required；历史缺省 false', async () => {
    const res = await createContainer({ purpose: 'idle', workloadPlan: [{ workloadId: 'wl-a', params: {}, implicit: false, required: true }] });
    const body = (await res.json()) as { id: string };
    await workloadLogRepository.createMany([
      { containerId: body.id, workloadId: 'wl-a', workloadName: 'wl-a', phase: 'init', status: 'failed', required: true },
      { containerId: body.id, workloadId: 'wl-b', workloadName: 'wl-b', phase: 'init', status: 'success' },
    ]);
    const logsRes = await fetch(`${baseUrl}/internal/containers/${body.id}/workload-logs`, {
      headers: authHeaders(),
    });
    const logs = (await logsRes.json()) as Array<{ required: boolean }>;
    expect(logs[0]!.required).toBe(true);
    expect(logs[1]!.required).toBe(false);
  });

  it('T-CC-B8: POST 透传 billingAccountId 并在 A.3 JSON 暴露', async () => {
    const res = await createContainer({ purpose: 'idle', billingAccountId: 'acct-1' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      billingAccountId: string | null;
      billingStartedAt: string | null;
    };
    expect(body.billingAccountId).toBe('acct-1');
    expect(body.billingStartedAt).toBeNull();

    const list = await fetch(`${baseUrl}/internal/containers`, { headers: authHeaders() });
    const items = (await list.json()) as Array<{ id: string; billingAccountId: string | null }>;
    expect(items.find((item) => item.id === body.id)?.billingAccountId).toBe('acct-1');
  });

  it('T-CC-B8: 非法 billingAccountId 返回 400', async () => {
    const res = await createContainer({ purpose: 'idle', billingAccountId: 123 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('INVALID_BILLING_ACCOUNT');
  });

  it('T-CC-B7: DELETE reason 写入 exitReason（query/body 均支持）', async () => {
    const created = await createContainer({ purpose: 'idle' });
    const body = (await created.json()) as { id: string };
    const reason = '余额不足超过 10 分钟，强制销毁';
    const deleted = await fetch(
      `${baseUrl}/internal/containers/${body.id}?reason=${encodeURIComponent(reason)}`,
      { method: 'DELETE', headers: authHeaders() },
    );
    expect(deleted.status).toBe(200);

    const list = await fetch(`${baseUrl}/internal/containers`, { headers: authHeaders() });
    const items = (await list.json()) as Array<{ id: string; exitReason: string | null }>;
    expect(items.find((item) => item.id === body.id)?.exitReason).toBe(reason);
  });

  it('T-CC2/T-CC3/T-CC16: harness 创建传 purpose=harness、落库新字段、响应无 secret', async () => {
    const secrets = {
      hostEndpoint: 'wss://controller.example.com',
      hostKey: 'zag_k_1_api-secret',
      modelApiKey: 'zag_sk_api-secret',
      modelBaseUrl: 'http://admin-api:8002/v1',
      modelIds: '["model-a"]',
      modelContextLengths: '{"model-a":128000}',
      defaultWorkspace: '/home/worker/workspace',
    };
    const expiresAt = new Date(Date.now() + 3600_000);
    const spy = vi.spyOn(containerService, 'start');

    const res = await createContainer({
      purpose: 'harness',
      hostId: 'host-api-1',
      refId: 'ck-api-1',
      userId: 'user-api-1',
      hostName: 'my-pc',
      harnessTypes: ['opencode'],
      expiresAt: expiresAt.toISOString(),
      agentGearMinVersion: '2.5.0',
      containerApiKeyId: 'ak-api-1',
      secrets,
      workloadPlan: [
        { workloadId: 'wl-a', params: {}, implicit: false, required: true },
      ],
    });

    expect(res.status).toBe(201);
    // T-CC3：purpose 变量被传给 containerService.start（不再硬编码 idle）
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.at(-1)?.[0]).toBe('harness');
    spy.mockRestore();

    const raw = await res.text();
    expect(raw).not.toContain(secrets.hostKey);
    expect(raw).not.toContain(secrets.modelApiKey);
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).toMatchObject({
      purpose: 'harness',
      hostId: 'host-api-1',
      hostName: 'my-pc',
      harnessTypes: ['opencode'],
      controllerKeyId: 'ck-api-1',
      containerApiKeyId: 'ak-api-1',
      userId: 'user-api-1',
      refId: 'ck-api-1',
      expiresAt: expiresAt.toISOString(),
    });
    expect(body.secrets).toBeUndefined();

    // 落库无 secret 明文
    const stored = await repo.findById(body.id as string);
    expect(JSON.stringify(stored)).not.toContain(secrets.hostKey);
    expect(JSON.stringify(stored)).not.toContain(secrets.modelApiKey);
    expect(stored?.agentGearMinVersion).toBe('2.17.1');

    // Job env 含 harness 变量且模型 Key 不进入 Job env
    const env = k8sClient.getEnv(body.name as string);
    expect(env.ZAG_HOST_ENDPOINT).toBe(secrets.hostEndpoint);
    expect(env.ZAG_HOST_KEY).toBe(secrets.hostKey);
    expect(env.ZAG_HOST_NAME).toBe('my-pc');
    expect(env.ZAG_HARNESS_TYPES).toBe('opencode');
    expect(env.ZAG_DEFAULT_WORKSPACE).toBe(secrets.defaultWorkspace);
    expect(env.ZAG_USER_TYPE).toBe('front_user');
    expect(env.ZAG_USER_ID).toBe('user-api-1');
    expect(env.ZAG_MODEL_API_KEY).toBeUndefined();

    const manifest = k8sClient.getManifest(body.name as string)!;
    // 最长运行时间无限制：Job 不再设置 activeDeadlineSeconds
    expect(manifest.spec).not.toHaveProperty('activeDeadlineSeconds');
  });

  it('T-IC-HARNESS: harness 落库 tenantId 与 userId 同值（tenantId 不改动 userId 维度）', async () => {
    const res = await createContainer({
      purpose: 'harness',
      hostId: 'host-tenant-1',
      refId: 'ck-tenant-1',
      userId: 'user-tenant-1',
      tenantId: 'user-tenant-1',
      hostName: 'pc-tenant-1',
      harnessTypes: ['opencode'],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      agentGearMinVersion: '2.10.0',
      secrets: {
        hostEndpoint: 'wss://controller.example.com',
        hostKey: 'zag_k_1_tenant',
        modelApiKey: 'zag_sk_tenant',
        modelBaseUrl: 'http://admin-api:8002/v1',
        modelIds: '["a"]',
        defaultWorkspace: '/home/worker/workspace',
      },
      workloadPlan: [{ workloadId: 'wl-a', params: {}, implicit: false, required: true }],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const stored = await repo.findById(body.id);
    expect(stored?.userId).toBe('user-tenant-1');
    expect(stored?.tenantId).toBe('user-tenant-1');
  });

  it('T-IC-HARNESS: 缺 tenantId 时回退 tenantId=userId 并 warn（滚动升级兜底）', async () => {
    testLog.reset();
    const res = await createContainer({
      purpose: 'harness',
      hostId: 'host-tenant-2',
      refId: 'ck-tenant-2',
      userId: 'user-tenant-2',
      hostName: 'pc-tenant-2',
      harnessTypes: ['opencode'],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      agentGearMinVersion: '2.10.0',
      secrets: {
        hostEndpoint: 'wss://controller.example.com',
        hostKey: 'zag_k_1_tenant_legacy',
        modelApiKey: 'zag_sk_tenant_legacy',
        modelBaseUrl: 'http://admin-api:8002/v1',
        modelIds: '["a"]',
        defaultWorkspace: '/home/worker/workspace',
      },
      workloadPlan: [{ workloadId: 'wl-a', params: {}, implicit: false, required: true }],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const stored = await repo.findById(body.id);
    expect(stored?.tenantId).toBe('user-tenant-2');
    // 断言 warn 的结构化记录（msg 含固定短语 + userId 进字段）
    expect(testLog.records).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        component: 'internal-api',
        msg: expect.stringContaining('缺少 tenantId'),
        userId: 'user-tenant-2',
      }),
    );
  });

  it('T-IC-HARNESS: tenantId 显式非法（空串/非字符串）→ 400 INVALID_HARNESS', async () => {
    const base = {
      purpose: 'harness',
      hostId: 'host-tenant-invalid',
      refId: 'ck-tenant-invalid',
      userId: 'user-tenant-invalid',
      hostName: 'pc-tenant-invalid',
      harnessTypes: ['opencode'],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      agentGearMinVersion: '2.10.0',
      secrets: {
        hostEndpoint: 'wss://controller.example.com',
        hostKey: 'zag_k_1_tenant_invalid',
        modelApiKey: 'zag_sk_tenant_invalid',
        modelBaseUrl: 'http://admin-api:8002/v1',
        modelIds: '["a"]',
        defaultWorkspace: '/home/worker/workspace',
      },
      workloadPlan: [{ workloadId: 'wl-a', params: {}, implicit: false, required: true }],
    };

    for (const tenantId of ['', '   ', 123]) {
      const res = await createContainer({ ...base, tenantId });
      expect(res.status, String(tenantId)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('INVALID_HARNESS');
    }
  });

  it('T-IC-HARNESS2a: 显式 workspaceId 落库（与 tenantId 并列）', async () => {
    const res = await createContainer(
      harnessPayload({ tenantId: 'tenant-ws-1', workspaceId: 'ws-explicit-1' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    // 契约附录 A.3：响应结构不变（workspaceId 仅落库，读侧由 agent-api 直连集合）
    expect(body).not.toHaveProperty('workspaceId');
    const stored = await repo.findById(body.id);
    expect(stored?.tenantId).toBe('tenant-ws-1');
    expect(stored?.workspaceId).toBe('ws-explicit-1');
  });

  it('T-IC-HARNESS2b: 缺失 workspaceId 时按 tenantId 解析全局工作区并落库', async () => {
    stubWorkspaceResolver.mockResolvedValue('ws-global-1');
    const res = await createStubContainer(
      harnessPayload({ tenantId: 'tenant-ws-global', workspaceId: undefined }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const stored = await repo.findById(body.id);
    expect(stubWorkspaceResolver).toHaveBeenCalledWith('tenant-ws-global');
    expect(stored?.workspaceId).toBe('ws-global-1');
  });

  it('T-IC-HARNESS2c: 缺失且解析不到 → 落库 null + warn（不阻断创建）', async () => {
    testLog.reset();
    stubWorkspaceResolver.mockResolvedValue(null);
    const res = await createStubContainer(
      harnessPayload({ tenantId: 'tenant-ws-missing', workspaceId: undefined }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const stored = await repo.findById(body.id);
    expect(stored?.workspaceId).toBeNull();
    // 断言 warn 的结构化记录（msg 含固定短语 + tenantId 进字段）
    expect(testLog.records).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        component: 'internal-api',
        msg: expect.stringContaining('缺少 workspaceId'),
        tenantId: 'tenant-ws-missing',
      }),
    );
  });

  it('T-IC-HARNESS2d: workspaceId 显式非法（空串/非字符串）→ 400 INVALID_HARNESS', async () => {
    for (const workspaceId of ['', '   ', 123, {}]) {
      const res = await createContainer(harnessPayload({ workspaceId }));
      expect(res.status, String(workspaceId)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('INVALID_HARNESS');
    }
  });

  it('C-4: agentGearMinVersion 落库为 max(服务端常量, 请求值)', async () => {
    const base = {
      purpose: 'harness',
      hostId: 'host-minver',
      refId: 'ck-minver',
      userId: 'user-minver',
      hostName: 'pc-minver',
      harnessTypes: ['opencode'],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      secrets: {
        hostEndpoint: 'wss://controller.example.com',
        hostKey: 'zag_k_1_minver',
        modelApiKey: 'zag_sk_minver',
        modelBaseUrl: 'http://admin-api:8002/v1',
        modelIds: '["a"]',
        defaultWorkspace: '/home/worker/workspace',
      },
      workloadPlan: [{ workloadId: 'wl-a', params: {}, implicit: false, required: true }],
    };

    const lower = await createContainer({ ...base, agentGearMinVersion: '2.1.0' });
    expect(lower.status).toBe(201);
    const lowerBody = (await lower.json()) as { id: string };
    expect((await repo.findById(lowerBody.id))?.agentGearMinVersion).toBe('2.17.1');

    const higher = await createContainer({ ...base, agentGearMinVersion: '2.18.0' });
    expect(higher.status).toBe(201);
    const higherBody = (await higher.json()) as { id: string };
    expect((await repo.findById(higherBody.id))?.agentGearMinVersion).toBe('2.18.0');
  });

  it('A7: harnessTypes 含 kimi_code → 落库 2.17.1；仅 opencode 亦为 2.17.1；非法类型 400', async () => {
    const base = {
      purpose: 'harness',
      hostId: 'host-kimi',
      refId: 'ck-kimi',
      userId: 'user-kimi',
      hostName: 'pc-kimi',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      agentGearMinVersion: '2.5.0',
      secrets: {
        hostEndpoint: 'wss://controller.example.com',
        hostKey: 'zag_k_1_kimi',
        modelApiKey: 'zag_sk_kimi',
        modelBaseUrl: 'http://admin-api:8002/v1',
        modelIds: '["a"]',
        defaultWorkspace: '/home/worker/workspace',
      },
      workloadPlan: [{ workloadId: 'wl-a', params: {}, implicit: false, required: true }],
    };

    const kimi = await createContainer({ ...base, harnessTypes: ['kimi_code'] });
    expect(kimi.status).toBe(201);
    const kimiBody = (await kimi.json()) as { id: string; harnessTypes: string[] };
    expect(kimiBody.harnessTypes).toEqual(['kimi_code']);
    expect((await repo.findById(kimiBody.id))?.agentGearMinVersion).toBe('2.17.1');

    const both = await createContainer({
      ...base,
      hostId: 'host-both',
      harnessTypes: ['opencode', 'kimi_code'],
    });
    expect(both.status).toBe(201);
    const bothBody = (await both.json()) as { id: string };
    expect((await repo.findById(bothBody.id))?.agentGearMinVersion).toBe('2.17.1');

    const opencode = await createContainer({
      ...base,
      hostId: 'host-opencode',
      harnessTypes: ['opencode'],
    });
    expect(opencode.status).toBe(201);
    const opencodeBody = (await opencode.json()) as { id: string };
    expect((await repo.findById(opencodeBody.id))?.agentGearMinVersion).toBe('2.17.1');

    const bogus = await createContainer({
      ...base,
      hostId: 'host-bogus',
      harnessTypes: ['kimi_code', 'bogus'],
    });
    expect(bogus.status).toBe(400);
    expect(((await bogus.json()) as { error: string }).error).toBe('INVALID_HARNESS');
  });

  it('A7b: harnessTypes 含 deepseek_harness → 落库 2.17.1；混合取最大；白名单外 400', async () => {
    const base = {
      purpose: 'harness',
      hostId: 'host-deepseek',
      refId: 'ck-deepseek',
      userId: 'user-deepseek',
      hostName: 'pc-deepseek',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      agentGearMinVersion: '2.5.0',
      secrets: {
        hostEndpoint: 'wss://controller.example.com',
        hostKey: 'zag_k_1_deepseek',
        modelApiKey: 'zag_sk_deepseek',
        modelBaseUrl: 'http://admin-api:8002/v1',
        modelIds: '["a"]',
        defaultWorkspace: '/home/worker/workspace',
      },
      workloadPlan: [{ workloadId: 'wl-a', params: {}, implicit: false, required: true }],
    };

    const deepseek = await createContainer({ ...base, harnessTypes: ['deepseek_harness'] });
    expect(deepseek.status).toBe(201);
    const deepseekBody = (await deepseek.json()) as { id: string; harnessTypes: string[] };
    expect(deepseekBody.harnessTypes).toEqual(['deepseek_harness']);
    expect((await repo.findById(deepseekBody.id))?.agentGearMinVersion).toBe('2.17.1');

    const mixed = await createContainer({
      ...base,
      hostId: 'host-deepseek-mixed',
      harnessTypes: ['opencode', 'kimi_code', 'deepseek_harness'],
    });
    expect(mixed.status).toBe(201);
    const mixedBody = (await mixed.json()) as { id: string };
    expect((await repo.findById(mixedBody.id))?.agentGearMinVersion).toBe('2.17.1');

    const bogus = await createContainer({
      ...base,
      hostId: 'host-deepseek-bogus',
      harnessTypes: ['deepseek_harness', 'bogus'],
    });
    expect(bogus.status).toBe(400);
    expect(((await bogus.json()) as { error: string }).error).toBe('INVALID_HARNESS');
  });

  it('T-CC5: harness 缺字段 / secrets 不完整 / harnessTypes 非法 → 400 INVALID_HARNESS 且不创建 Job', async () => {
    const valid = {
      purpose: 'harness',
      hostId: 'host-invalid',
      refId: 'ck-invalid',
      userId: 'user-invalid',
      hostName: 'pc',
      harnessTypes: ['opencode'],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      agentGearMinVersion: '2.5.0',
      secrets: {
        hostEndpoint: 'wss://controller.example.com',
        hostKey: 'zag_k_1_x',
        modelApiKey: 'zag_sk_x',
        modelBaseUrl: 'http://admin-api:8002/v1',
        modelIds: '["a"]',
        defaultWorkspace: '/home/worker/workspace',
      },
      workloadPlan: [{ workloadId: 'wl-a', params: {}, implicit: false, required: true }],
    };

    const cases: Array<[string, Record<string, unknown>]> = [
      ['missing hostId', { ...valid, hostId: undefined }],
      ['empty hostId', { ...valid, hostId: '' }],
      ['missing refId', { ...valid, refId: undefined }],
      ['missing userId', { ...valid, userId: undefined }],
      ['missing hostName', { ...valid, hostName: undefined }],
      ['harnessTypes 非数组', { ...valid, harnessTypes: 'opencode' }],
      ['unsupported harness type', { ...valid, harnessTypes: ['unknown'] }],
      ['invalid expiresAt', { ...valid, expiresAt: 'not-a-date' }],
      ['missing agentGearMinVersion', { ...valid, agentGearMinVersion: undefined }],
      ['invalid agentGearMinVersion', { ...valid, agentGearMinVersion: '2.x' }],
      ['missing secrets', { ...valid, secrets: undefined }],
      ['incomplete secrets', { ...valid, secrets: { ...valid.secrets, hostKey: '' } }],
    ];

    for (const [label, body] of cases) {
      const containersBefore = (await repo.findAll()).length;
      const jobsBefore = k8sClient.createdManifests.length;
      const res = await createContainer(body);
      expect(res.status, label).toBe(400);
      const error = (await res.json()) as { error: string };
      expect(error.error, label).toBe('INVALID_HARNESS');
      expect((await repo.findAll()).length, label).toBe(containersBefore);
      expect(k8sClient.createdManifests.length, label).toBe(jobsBefore);
    }
  });

  it('T-CC-AH: 0-harness + 空 workloadPlan 允许创建（容器直接可上线）', async () => {
    const res = await createContainer(harnessPayload({ harnessTypes: [], workloadPlan: [] }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.harnessTypes).toEqual([]);
    expect(body.workloadPlan).toEqual([]);
    expect(body.status).toBe('connecting');
  });

  it('T-CC-R4: runtime harness 安装逐类型版本门禁（满足/不满足/版本不可得）', async () => {
    runtimeDispatcher.startRuntimeBatch.mockClear();
    testLog.reset();

    // 2.11.0 < max(deepseek_harness 2.17.1, 基线 2.17.1) → 400 可读拒绝
    getWorkerVersion.mockReturnValue('2.11.0');
    const rejected = await startRuntimeOnOnlineContainer('507f1f77bcf86cd7994390a1');
    expect(rejected.status).toBe(400);
    const rejectedBody = (await rejected.json()) as { error: string; message: string };
    expect(rejectedBody.error).toBe('INVALID_WORKLOAD');
    expect(rejectedBody.message).toContain('2.17.1');
    expect(rejectedBody.message).toContain('DeepSeek Harness（Harness）');
    expect(runtimeDispatcher.startRuntimeBatch).not.toHaveBeenCalled();

    // 2.17.1 满足 → 放行
    getWorkerVersion.mockReturnValue('2.17.1');
    const allowed = await startRuntimeOnOnlineContainer('507f1f77bcf86cd7994390a1');
    expect(allowed.status).toBe(200);
    expect(runtimeDispatcher.startRuntimeBatch).toHaveBeenCalledTimes(1);
    // harness 负载：批次条目标记为需要 harness env（Issue #446 的判定输入）。
    const harnessInput = runtimeDispatcher.startRuntimeBatch.mock.calls[0]![1] as {
      entries: Array<{ requiresHarnessEnv?: boolean }>;
    };
    expect(harnessInput.entries[0]!.requiresHarnessEnv).toBe(true);

    // 版本不可得 → 放行 + warn 留痕
    runtimeDispatcher.startRuntimeBatch.mockClear();
    getWorkerVersion.mockReturnValue(undefined);
    const unknown = await startRuntimeOnOnlineContainer('507f1f77bcf86cd7994390a1');
    expect(unknown.status).toBe(200);
    expect(runtimeDispatcher.startRuntimeBatch).toHaveBeenCalledTimes(1);
    expect(
      testLog.records.some(
        (r) => r.level === 'warn' && r.event === 'runtime-harness-version-unknown',
      ),
    ).toBe(true);

    // standard 负载不进门禁（低版本也放行）
    runtimeDispatcher.startRuntimeBatch.mockClear();
    getWorkerVersion.mockReturnValue('2.2.0');
    const standard = await startRuntimeOnOnlineContainer('507f1f77bcf86cd7994390a2');
    expect(standard.status).toBe(200);
    expect(runtimeDispatcher.startRuntimeBatch).toHaveBeenCalledTimes(1);
    const standardInput = runtimeDispatcher.startRuntimeBatch.mock.calls[0]![1] as {
      entries: Array<{ requiresHarnessEnv?: boolean }>;
    };
    expect(standardInput.entries[0]!.requiresHarnessEnv).toBe(false);
  });

  it('T-CC-RS1~3: runtime-scripts 透传可选 githubRepoFullName 且非法 400', async () => {
    const id = '507f1f77bcf86cd7994390b1';
    const endpoint = `${baseUrl}/gate/containers/${id}/runtime-scripts`;
    const body = (overrides: Record<string, unknown> = {}) => ({
      workloadId: '507f1f77bcf86cd7994390c1',
      workloadName: 'Git 项目设置',
      script: 'echo setup',
      params: { repoFullName: 'owner/repo' },
      source: 'system',
      githubAuth: true,
      ...overrides,
    });
    const post = (payload: Record<string, unknown>) =>
      fetch(endpoint, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });

    // T-CC-RS1：合法值透传
    runtimeDispatcher.startRuntimeBatch.mockClear();
    expect((await post(body({ githubRepoFullName: ' owner/repo ' }))).status).toBe(200);
    const input = runtimeDispatcher.startRuntimeBatch.mock.calls[0]![1] as {
      githubRepoFullName?: string;
    };
    expect(input.githubRepoFullName).toBe('owner/repo');

    // T-CC-RS2：缺省不出现该键
    runtimeDispatcher.startRuntimeBatch.mockClear();
    expect((await post(body())).status).toBe(200);
    const absent = runtimeDispatcher.startRuntimeBatch.mock.calls[0]![1] as Record<string, unknown>;
    expect('githubRepoFullName' in absent).toBe(false);

    // T-CC-RS3：非法值 400 INVALID_SCRIPT
    for (const invalid of ['bad', 'a/b/c', 'own er/repo', `${'a'.repeat(100)}/${'b'.repeat(100)}`]) {
      runtimeDispatcher.startRuntimeBatch.mockClear();
      const res = await post(body({ githubRepoFullName: invalid }));
      expect(res.status, invalid).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('INVALID_SCRIPT');
      expect(runtimeDispatcher.startRuntimeBatch).not.toHaveBeenCalled();
    }
  });

  it('T-CC-MP2: parseHarnessRequest 可选 modelProviders（携带透传 / 缺失不写 / 非法 400）', async () => {
    const modelProviders = JSON.stringify({
      providers: [
        { vendorId: 'zag', displayName: 'Agent Gear', models: [{ id: 'model-a' }] },
      ],
    });
    const base = harnessPayload() as Record<string, unknown>;
    const secrets = base.secrets as Record<string, unknown>;
    const deps = { resolveGlobalWorkspaceId: async () => null };

    // 携带即透传（不参与必填校验、不做业务语义校验）
    const carried = await parseHarnessRequest(
      { ...base, secrets: { ...secrets, modelProviders } },
      deps,
    );
    expect(carried?.secrets.modelProviders).toBe(modelProviders);

    // 缺失 → 不写字段（旧调用方零回归）
    const missing = await parseHarnessRequest({ ...base }, deps);
    expect(missing).not.toBeNull();
    expect('modelProviders' in (missing?.secrets ?? {})).toBe(false);

    // 空串 / 非字符串 → 非法（400 INVALID_HARNESS 由路由层返回）
    for (const invalid of ['', '   ', 1, { providers: [] }]) {
      const raw = await parseHarnessRequest(
        { ...base, secrets: { ...secrets, modelProviders: invalid } },
        deps,
      );
      expect(raw, String(invalid)).toBeNull();
    }

    // 路由层口径：空串 → 400 INVALID_HARNESS
    const res = await createContainer({
      ...base,
      secrets: { ...secrets, modelProviders: '' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('INVALID_HARNESS');
  });

  it('T-PRS1~3: spec 载荷解析（合法透传/缺省 null/非法组合 400）与快照落库', async () => {
    const base = harnessPayload() as Record<string, unknown>;
    const deps = { resolveGlobalWorkspaceId: async () => null };
    const spec = { id: 'spec-1', name: '8C 16G 20G', cpu: 8, memoryGi: 16, ephemeralStorageGi: 20 };

    const carried = await parseHarnessRequest({ ...base, spec }, deps);
    expect(carried?.spec).toEqual(spec);

    const missing = await parseHarnessRequest({ ...base }, deps);
    expect(missing).not.toBeNull();
    expect(missing?.spec).toBeNull();

    const unlimited = await parseHarnessRequest(
      { ...base, spec: { ...spec, name: '0C 0G 0G', cpu: 0, memoryGi: 0, ephemeralStorageGi: 0 } },
      deps,
    );
    expect(unlimited?.spec?.cpu).toBe(0);

    for (const invalid of [
      { ...spec, cpu: 0 },
      { ...spec, memoryGi: 0 },
      { ...spec, ephemeralStorageGi: 0 },
      { ...spec, cpu: 65 },
      { ...spec, memoryGi: 257 },
      { ...spec, ephemeralStorageGi: 513 },
      { ...spec, cpu: 1.5 },
      { ...spec, id: '' },
      { ...spec, name: '' },
      'bad',
      [],
    ]) {
      expect(await parseHarnessRequest({ ...base, spec: invalid }, deps), JSON.stringify(invalid)).toBeNull();
    }

    // 路由层口径：非法 spec → 400 INVALID_HARNESS，不创建容器
    const res = await createContainer({ ...base, spec: { ...spec, cpu: 0 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('INVALID_HARNESS');
  });

  it('T-PRS3: cloudcontainers 落规格快照五字段', async () => {
    const base = harnessPayload() as Record<string, unknown>;
    const spec = { id: '507f1f77bcf86cd7994390b1', name: '8C 16G 20G', cpu: 8, memoryGi: 16, ephemeralStorageGi: 20 };
    const res = await createContainer({ ...base, spec });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const created = await repo.findById(body.id);
    expect(created?.specId).toBe(spec.id);
    expect(created?.specName).toBe(spec.name);
    expect(created?.specCpu).toBe(8);
    expect(created?.specMemoryGi).toBe(16);
    expect(created?.specEphemeralStorageGi).toBe(20);
  });

  it('T-CC-MP3: harness-models 端点四态矩阵（404/409/offline/worker_unsupported/400/503/ack）', async () => {
    const provision = {
      providers: [
        { vendorId: 'zag', displayName: 'Agent Gear', models: [{ id: 'model-a' }] },
      ],
    };
    const push = (containerId: string, body: unknown = { provision }, base = '/modelpush') =>
      fetch(`${baseUrl}${base}/containers/${containerId}/harness-models`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
    /** 受控容器（合法 ObjectId）：状态与 secret 存在性由用例决定。 */
    const newContainer = (status: string, hasSecret = true): string => {
      pushSeq += 1;
      const id = `507f1f77bcf86cd7994${String(pushSeq).padStart(5, '0')}`;
      pushContainers.set(id, { status, hasSecret });
      return id;
    };

    requestHarnessModelsStub.mockClear();
    pushUpdateModelProvision.mockClear();
    pushWorkerVersion.mockReset();
    pushWorkerVersion.mockReturnValue('2.20.0');

    // 非法 ID / 不存在 → 404
    const invalidId = await push('not-an-object-id');
    expect(invalidId.status).toBe(404);
    expect(((await invalidId.json()) as { error: string }).error).toBe('NOT_FOUND');
    const missing = await push('507f1f77bcf86cd799439011');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe('NOT_FOUND');

    // 终态 → 409 CONTAINER_NOT_ONLINE
    const terminal = await push(newContainer('exited'));
    expect(terminal.status).toBe(409);
    expect(((await terminal.json()) as { error: string }).error).toBe('CONTAINER_NOT_ONLINE');

    // 创建中间态（creating/connecting/initializing）→ 200 offline；**仍先持久化**，不 emit
    for (const status of ['creating', 'connecting', 'initializing'] as const) {
      const res = await push(newContainer(status));
      expect(res.status, status).toBe(200);
      expect(await res.json(), status).toEqual({ delivered: false, reason: 'offline' });
    }
    expect(pushUpdateModelProvision).toHaveBeenCalledTimes(3);
    expect(requestHarnessModelsStub).not.toHaveBeenCalled();

    // worker 版本 <2.20.0 → 200 worker_unsupported（不 emit，但**已持久化**，D11/F17）
    pushWorkerVersion.mockReturnValue('2.19.0');
    const unsupported = await push(newContainer('online'));
    expect(unsupported.status).toBe(200);
    expect(await unsupported.json()).toEqual({
      delivered: false,
      reason: 'worker_unsupported',
    });
    expect(requestHarnessModelsStub).not.toHaveBeenCalled();
    expect(pushUpdateModelProvision).toHaveBeenCalledTimes(4);

    // 非法 payload 先于离线/版本短路：中间态也返回 400（不被 200 delivered:false 掩盖）
    const offlineInvalid = await push(newContainer('creating'), { provision: { providers: 'nope' } });
    expect(offlineInvalid.status).toBe(400);
    expect(((await offlineInvalid.json()) as { error: string }).error).toBe('INVALID_MODEL_PROVISION');
    expect(pushUpdateModelProvision).toHaveBeenCalledTimes(4);

    // 版本不可得 → 不短路（正常 emit）
    pushWorkerVersion.mockReturnValue(undefined);
    const unknownVersionRes = await push(newContainer('online'));
    expect(unknownVersionRes.status).toBe(200);
    expect(await unknownVersionRes.json()).toEqual({
      delivered: true,
      appliedTypes: ['opencode'],
    });
    expect(requestHarnessModelsStub).toHaveBeenCalledTimes(1);

    // payload 非法 → 400 INVALID_MODEL_PROVISION
    requestHarnessModelsStub.mockClear();
    pushUpdateModelProvision.mockClear();
    pushWorkerVersion.mockReturnValue('2.20.0');
    const online = newContainer('online');
    for (const bad of [
      {},
      { provision: null },
      { provision: { providers: 'nope' } },
      {
        provision: {
          providers: [
            { vendorId: 'zag', displayName: 'Agent Gear', models: [{ id: 'a', contextLength: 0 }] },
          ],
        },
      },
    ]) {
      const res = await push(online, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('INVALID_MODEL_PROVISION');
    }
    expect(pushUpdateModelProvision).not.toHaveBeenCalled();
    expect(requestHarnessModelsStub).not.toHaveBeenCalled();

    // secret 缺失（容器已销毁/未创建 secret）→ 409
    const noSecret = await push(newContainer('online', false));
    expect(noSecret.status).toBe(409);
    expect(((await noSecret.json()) as { error: string }).error).toBe('CONTAINER_NOT_ONLINE');

    // 正常路径：先持久化再 emit，回传 ack 结果
    pushUpdateModelProvision.mockClear();
    requestHarnessModelsStub.mockClear();
    const success = await push(online);
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ delivered: true, appliedTypes: ['opencode'] });
    expect(pushUpdateModelProvision).toHaveBeenCalledWith(online, provision);
    expect(requestHarnessModelsStub).toHaveBeenCalledTimes(1);
    expect(requestHarnessModelsStub.mock.calls[0]![0]).toBe(online);
    expect(requestHarnessModelsStub.mock.calls[0]![1]).toEqual(provision);
    expect(pushUpdateModelProvision.mock.invocationCallOrder[0]!).toBeLessThan(
      requestHarnessModelsStub.mock.invocationCallOrder[0]!,
    );

    // 网关回传失败也按 200 + delivered:false（不视为保存失败）
    requestHarnessModelsStub.mockResolvedValueOnce({
      delivered: false,
      reason: 'ack_timeout',
    });
    const timeoutRes = await push(online);
    expect(timeoutRes.status).toBe(200);
    expect(await timeoutRes.json()).toEqual({ delivered: false, reason: 'ack_timeout' });

    // 网关未注入 → 503（`/internal` 路由无 requestHarnessModels；优先于容器校验）
    const unavailable = await push('507f1f77bcf86cd799439011', { provision }, '/internal');
    expect(unavailable.status).toBe(503);
    expect(((await unavailable.json()) as { error: string }).error).toBe('UNAVAILABLE');

    requestHarnessModelsStub.mockResolvedValue({ delivered: true, appliedTypes: ['opencode'] });
  });

  it('T-CC15: GET /containers 支持 hostId/userId 过滤，无参数保持全量', async () => {
    const makeHarness = (hostId: string, userId: string) =>
      createContainer({
        purpose: 'harness',
        hostId,
        refId: `ck-${hostId}`,
        userId,
        hostName: hostId,
        harnessTypes: ['opencode'],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        agentGearMinVersion: '2.5.0',
        secrets: {
          hostEndpoint: 'wss://controller.example.com',
          hostKey: 'zag_k_1_filter',
          modelApiKey: 'zag_sk_filter',
          modelBaseUrl: 'http://admin-api:8002/v1',
          modelIds: '[]',
          defaultWorkspace: '/home/worker/workspace',
        },
        workloadPlan: [{ workloadId: 'wl-a', params: {}, implicit: false, required: true }],
      });

    expect((await makeHarness('host-filter-a', 'user-filter-a')).status).toBe(201);
    expect((await makeHarness('host-filter-b', 'user-filter-b')).status).toBe(201);

    const all = (await (
      await fetch(`${baseUrl}/internal/containers`, { headers: authHeaders() })
    ).json()) as Array<{ id: string }>;
    const byHost = (await (
      await fetch(`${baseUrl}/internal/containers?hostId=host-filter-a`, {
        headers: authHeaders(),
      })
    ).json()) as Array<Record<string, unknown>>;
    expect(byHost).toHaveLength(1);
    expect(byHost[0]!.hostId).toBe('host-filter-a');

    const byUser = (await (
      await fetch(`${baseUrl}/internal/containers?userId=user-filter-b`, {
        headers: authHeaders(),
      })
    ).json()) as Array<Record<string, unknown>>;
    expect(byUser).toHaveLength(1);
    expect(byUser[0]!.userId).toBe('user-filter-b');

    const missing = (await (
      await fetch(`${baseUrl}/internal/containers?hostId=host-missing`, {
        headers: authHeaders(),
      })
    ).json()) as unknown[];
    expect(missing).toEqual([]);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

describe('A.2.14 立即升级工作组件（T-UPG-I）', () => {
  beforeEach(() => {
    getWorkerVersion.mockReset();
    requestAgentGearUpgrade.mockReset();
  });

  async function makeContainer(status: 'online' | 'connecting' | 'exited' = 'online') {
    return repo.create({
      name: `zag-worker-upg-${Math.random().toString(36).slice(2, 8)}`,
      namespace: 'zag-workers',
      purpose: 'idle',
      image: 'zero-tools/zag-worker:latest',
      status,
    });
  }

  function upgrade(id: string, body?: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/upgrade/containers/${id}/upgrade-agent-gear`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  it('T-UPG-I1: 容器不存在 → 404 NOT_FOUND', async () => {
    const res = await upgrade('507f1f77bcf86cd799439011');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('NOT_FOUND');
    expect(requestAgentGearUpgrade).not.toHaveBeenCalled();
  });

  it('T-UPG-I2: 非 online / 无活跃 socket → 409 CONTAINER_NOT_ONLINE', async () => {
    const connecting = await makeContainer('connecting');
    const res = await upgrade(connecting.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('CONTAINER_NOT_ONLINE');

    const online = await makeContainer('online');
    getWorkerVersion.mockReturnValueOnce('2.20.0');
    requestAgentGearUpgrade.mockResolvedValueOnce({ code: 'NOT_ONLINE' });
    const noSocket = await upgrade(online.id);
    expect(noSocket.status).toBe(409);
    expect((await noSocket.json()).error).toBe('CONTAINER_NOT_ONLINE');
  });

  it('T-UPG-I3: 上报版本 <2.20.0 或未上报 → 400 UPGRADE_UNSUPPORTED；2.20.0 放行', async () => {
    const container = await makeContainer('online');
    for (const version of [undefined, '2.19.0']) {
      getWorkerVersion.mockReturnValueOnce(version);
      const res = await upgrade(container.id);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('UPGRADE_UNSUPPORTED');
    }

    getWorkerVersion.mockReturnValueOnce('2.20.0');
    requestAgentGearUpgrade.mockResolvedValueOnce({
      code: 'ACCEPTED',
      currentVersion: '2.20.0',
    });
    const ok = await upgrade(container.id, { targetVersion: '2.21.0' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      accepted: true,
      containerId: container.id,
      currentVersion: '2.20.0',
    });
    expect(requestAgentGearUpgrade).toHaveBeenLastCalledWith(container.id, {
      targetVersion: '2.21.0',
    });
  });

  it('T-UPG-I4: 在飞 409 IN_PROGRESS；拒绝/超时 409 NOT_ACCEPTED', async () => {
    const container = await makeContainer('online');
    getWorkerVersion.mockReturnValue('2.20.0');
    for (const [code, expected] of [
      ['IN_PROGRESS', 'UPGRADE_IN_PROGRESS'],
      ['NOT_ACCEPTED', 'UPGRADE_NOT_ACCEPTED'],
    ] as const) {
      requestAgentGearUpgrade.mockResolvedValueOnce({ code });
      const res = await upgrade(container.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(expected);
    }
    getWorkerVersion.mockReset();
  });

  it('T-UPG-I5: A.3 透出 agentGearVersion（有值透传、缺省 null）', async () => {
    const empty = await makeContainer('online');
    const valued = await repo.create({
      name: `zag-worker-upg2-${Math.random().toString(36).slice(2, 8)}`,
      namespace: 'zag-workers',
      purpose: 'idle',
      image: 'zero-tools/zag-worker:latest',
      status: 'online',
      agentGearVersion: '2.20.0',
    });
    const list = await fetch(`${baseUrl}/internal/containers`, { headers: authHeaders() });
    const items = (await list.json()) as Array<Record<string, unknown>>;
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get(empty.id)?.agentGearVersion).toBeNull();
    expect(byId.get(valued.id)?.agentGearVersion).toBe('2.20.0');
  });
});
