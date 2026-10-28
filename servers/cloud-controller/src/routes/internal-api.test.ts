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
import { createInternalRouter } from './internal-api.js';

const INTERNAL_TOKEN = 'test-internal-token';

let httpServer: HttpServer;
let baseUrl: string;
let repo: InMemoryContainerRepository;
let k8sClient: InMemoryK8sClient;
let containerService: ContainerService;
let workloadLogRepository: InMemoryWorkloadLogRepository;
let workloadRepository: InMemoryWorkloadRepository;

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
  const service = new ContainerService(repo, tokenService, jobManager, {
    namespace: 'zag-workers',
    image: 'zero-tools/zag-worker:latest',
    connectTimeoutMs: 300000,
    shutdownGraceMs: 0,
  });
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

  workloadLogRepository = new InMemoryWorkloadLogRepository();

  const app = express();
  app.use(express.json());
  app.use(
    '/internal',
    internalAuth(INTERNAL_TOKEN),
    createInternalRouter(service, { workloadRepository, workloadLogRepository }),
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
    expect(stored?.agentGearMinVersion).toBe('2.10.0');

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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
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
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('缺少 tenantId'),
      );
    } finally {
      warnSpy.mockRestore();
    }
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
    expect((await repo.findById(lowerBody.id))?.agentGearMinVersion).toBe('2.10.0');

    const higher = await createContainer({ ...base, agentGearMinVersion: '2.10.0' });
    expect(higher.status).toBe(201);
    const higherBody = (await higher.json()) as { id: string };
    expect((await repo.findById(higherBody.id))?.agentGearMinVersion).toBe('2.10.0');
  });

  it('A7: harnessTypes 含 kimi_code → 落库 2.10.0；仅 opencode 维持 2.10.0；非法类型 400', async () => {
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
    expect((await repo.findById(kimiBody.id))?.agentGearMinVersion).toBe('2.10.0');

    const both = await createContainer({
      ...base,
      hostId: 'host-both',
      harnessTypes: ['opencode', 'kimi_code'],
    });
    expect(both.status).toBe(201);
    const bothBody = (await both.json()) as { id: string };
    expect((await repo.findById(bothBody.id))?.agentGearMinVersion).toBe('2.10.0');

    const opencode = await createContainer({
      ...base,
      hostId: 'host-opencode',
      harnessTypes: ['opencode'],
    });
    expect(opencode.status).toBe(201);
    const opencodeBody = (await opencode.json()) as { id: string };
    expect((await repo.findById(opencodeBody.id))?.agentGearMinVersion).toBe('2.10.0');

    const bogus = await createContainer({
      ...base,
      hostId: 'host-bogus',
      harnessTypes: ['kimi_code', 'bogus'],
    });
    expect(bogus.status).toBe(400);
    expect(((await bogus.json()) as { error: string }).error).toBe('INVALID_HARNESS');
  });

  it('A7b: harnessTypes 含 deepseek_harness → 落库 2.11.0；混合取最大；白名单外 400', async () => {
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
    expect((await repo.findById(deepseekBody.id))?.agentGearMinVersion).toBe('2.11.0');

    const mixed = await createContainer({
      ...base,
      hostId: 'host-deepseek-mixed',
      harnessTypes: ['opencode', 'kimi_code', 'deepseek_harness'],
    });
    expect(mixed.status).toBe(201);
    const mixedBody = (await mixed.json()) as { id: string };
    expect((await repo.findById(mixedBody.id))?.agentGearMinVersion).toBe('2.11.0');

    const bogus = await createContainer({
      ...base,
      hostId: 'host-deepseek-bogus',
      harnessTypes: ['deepseek_harness', 'bogus'],
    });
    expect(bogus.status).toBe(400);
    expect(((await bogus.json()) as { error: string }).error).toBe('INVALID_HARNESS');
  });

  it('T-CC5: harness 缺字段 / secrets 不完整 / harnessTypes 非法 / workloadPlan 缺失 → 400 INVALID_HARNESS 且不创建 Job', async () => {
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
      ['empty harnessTypes', { ...valid, harnessTypes: [] }],
      ['unsupported harness type', { ...valid, harnessTypes: ['unknown'] }],
      ['invalid expiresAt', { ...valid, expiresAt: 'not-a-date' }],
      ['missing agentGearMinVersion', { ...valid, agentGearMinVersion: undefined }],
      ['invalid agentGearMinVersion', { ...valid, agentGearMinVersion: '2.x' }],
      ['missing secrets', { ...valid, secrets: undefined }],
      ['incomplete secrets', { ...valid, secrets: { ...valid.secrets, hostKey: '' } }],
      ['missing workloadPlan', { ...valid, workloadPlan: undefined }],
      ['empty workloadPlan', { ...valid, workloadPlan: [] }],
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
