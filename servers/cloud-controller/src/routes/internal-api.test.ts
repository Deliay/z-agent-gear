import { afterAll, beforeAll, describe, it, expect } from 'vitest';
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
  const repo = new InMemoryContainerRepository();
  const client = new InMemoryK8sClient();
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
        'connectedAt',
        'createdAt',
        'currentWorkloadName',
        'exitReason',
        'exitedAt',
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

  it('T-R3: non-idle purpose is rejected with a clear message', async () => {
    const res = await createContainer({ purpose: 'workflow' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('该任务类型暂未开放');
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
});
