import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { InMemoryK8sClient } from '../../../../servers/cloud-controller/src/services/k8s-client';
import { K8sJobManager } from '../../../../servers/cloud-controller/src/services/k8s-job-manager';

// cloud-controller 内部管理 REST（契约附录 A）。由 Aspire 以 K8S_ENABLED=false 启动。
// INTERNAL_API_TOKEN 已无公开默认值（问题 47）：须经环境注入，未提供时显式跳过而非静默假绿。
const BASE = process.env.CLOUD_CONTROLLER_URL || 'http://localhost:10004';
const TOKEN = process.env.CLOUD_CONTROLLER_INTERNAL_TOKEN;
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

function req(path: string, init: RequestInit = {}, withAuth = true): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) };
  if (withAuth) headers.Authorization = `Bearer ${TOKEN}`;
  return fetch(`${BASE}${path}`, { ...init, headers });
}

/** 惰性连接共享 Mongo（cloud-controller 与 admin-api 共享同一实例）。 */
async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

/** 直写一条 `cloudworkloads` 定义（cloud-controller 只读），用于计划/兜底展开用例。 */
async function insertWorkload(
  db: mongoose.mongo.Db,
  input: {
    initScript?: string;
    paramSchema?: Array<{
      key: string;
      label: string;
      type: string;
      options?: string[];
      defaultValue: unknown;
    }>;
    dependsOnWorkloadIds?: mongoose.Types.ObjectId[];
  } = {},
): Promise<mongoose.Types.ObjectId> {
  const id = new mongoose.Types.ObjectId();
  const now = new Date();
  await db.collection('cloudworkloads').insertOne({
    _id: id,
    name: `icc-workload-${id.toString()}`,
    initScript: input.initScript ?? 'echo init',
    postScript: null,
    paramSchema: input.paramSchema ?? [],
    dependsOnWorkloadIds: input.dependsOnWorkloadIds ?? [],
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe.skipIf(!TOKEN)('cloud-controller internal API', () => {
  it('T-IC2: rejects missing / wrong bearer with 401', async () => {
    const missing = await req('/internal/containers', {}, false);
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${BASE}/internal/containers`, { headers: { Authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
  });

  it('T-IC3: rejects non-idle purpose with explicit message', async () => {
    const res = await req('/internal/containers', { method: 'POST', body: JSON.stringify({ purpose: 'workflow' }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('该任务类型暂未开放');
  });

  it('T-IC1: full lifecycle conforms to contract appendix A', async () => {
    const listRes = await req('/internal/containers');
    expect(listRes.status).toBe(200);
    expect(Array.isArray(await listRes.json())).toBe(true);

    const startRes = await req('/internal/containers', { method: 'POST', body: JSON.stringify({ purpose: 'idle' }) });
    expect(startRes.status).toBe(201);
    const created = (await startRes.json()) as Record<string, unknown>;
    expect(created).toMatchObject({ purpose: 'idle', status: 'connecting', refId: null });
    expect(typeof created.id).toBe('string');
    expect(typeof created.createdAt).toBe('string');
    // A.3 扩展字段：缺省挂载为 []、当前脚本名为 null
    expect(created.workloadIds).toEqual([]);
    expect(created.currentWorkloadName).toBeNull();

    const delRes = await req(`/internal/containers/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    // 问题 50：DELETE 透出契约承诺的 deletedJob
    await expect(delRes.json()).resolves.toMatchObject({ success: true, deletedJob: true });
  });

  it('T-IC4: DELETE 404 for unknown; idempotent for terminal container', async () => {
    const unknown = await req('/internal/containers/nope', { method: 'DELETE' });
    expect(unknown.status).toBe(404);

    const startRes = await req('/internal/containers', { method: 'POST', body: JSON.stringify({ purpose: 'idle' }) });
    const created = (await startRes.json()) as { id: string };

    expect((await req(`/internal/containers/${created.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await req(`/internal/containers/${created.id}`, { method: 'DELETE' })).status).toBe(200);
  });

  // 显式 skipIf（而非静默早退）：MONGODB_URI 缺失时该安全断言必须显示为 skipped。
  it.skipIf(!HAS_MONGO)(
    'T-CC2/T-CC6/T-CC16: creates harness container and never echoes secrets',
    async () => {
      const db = await mongoDb();
      expect(db).not.toBeNull();

      const workloadId = await insertWorkload(db!);
      const hostId = new mongoose.Types.ObjectId().toString();
      const secrets = {
        hostEndpoint: 'wss://controller-api.internal',
        hostKey: 'zag_k_1_test_secret',
        modelApiKey: 'zag_sk_test_secret',
        modelBaseUrl: 'http://admin-api:8002/v1',
        modelIds: '["model-a"]',
        modelContextLengths: '{"model-a":128000}',
        defaultWorkspace: '/root/workspace',
      };

      let containerId: string | null = null;
      try {
        const created = await req('/internal/containers', {
          method: 'POST',
          body: JSON.stringify({
            purpose: 'harness',
            hostId,
            refId: new mongoose.Types.ObjectId().toString(),
            userId: new mongoose.Types.ObjectId().toString(),
            hostName: 'harness-it',
            harnessTypes: ['opencode'],
            containerApiKeyId: new mongoose.Types.ObjectId().toString(),
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            agentGearMinVersion: '2.5.0',
            secrets,
            workloadPlan: [
              { workloadId: workloadId.toString(), params: {}, implicit: false, required: true },
            ],
          }),
        });
        expect(created.status).toBe(201);
        const raw = await created.text();
        expect(raw).not.toContain(secrets.hostKey);
        expect(raw).not.toContain(secrets.modelApiKey);
        const body = JSON.parse(raw) as Record<string, unknown>;
        containerId = String(body.id);
        expect(body).toMatchObject({
          purpose: 'harness',
          hostId,
          hostName: 'harness-it',
          harnessTypes: ['opencode'],
        });
        expect(body.secrets).toBeUndefined();
        expect(body.controllerKeyId).toBeTruthy();
        expect(body.containerApiKeyId).toBeTruthy();

        const list = (await (
          await req(`/internal/containers?hostId=${hostId}`)
        ).json()) as Array<{ hostId?: string }>;
        expect(list.length).toBeGreaterThan(0);
        expect(list.every((item) => item.hostId === hostId)).toBe(true);
      } finally {
        if (containerId) {
          await req(`/internal/containers/${containerId}`, { method: 'DELETE' });
          await db!
            .collection('cloudworkloadlogs')
            .deleteMany({ containerId: new mongoose.Types.ObjectId(containerId) });
        }
        await db!.collection('cloudworkloads').deleteOne({ _id: workloadId });
      }
    },
  );

  it('T-IC5: rejects invalid workloadIds with 400 INVALID_WORKLOAD', async () => {
    // 非数组
    const notArray = await req('/internal/containers', {
      method: 'POST',
      body: JSON.stringify({ purpose: 'idle', workloadIds: 'nope' }),
    });
    expect(notArray.status).toBe(400);
    await expect(notArray.json()).resolves.toMatchObject({ error: 'INVALID_WORKLOAD' });

    // 超过 10 个（格式合法但不存在，命中数量上限分支）
    const tooMany = Array.from({ length: 11 }, () => new mongoose.Types.ObjectId().toString());
    const overLimit = await req('/internal/containers', {
      method: 'POST',
      body: JSON.stringify({ purpose: 'idle', workloadIds: tooMany }),
    });
    expect(overLimit.status).toBe(400);
    await expect(overLimit.json()).resolves.toMatchObject({ error: 'INVALID_WORKLOAD' });

    // 不存在的 ID
    const unknown = await req('/internal/containers', {
      method: 'POST',
      body: JSON.stringify({ purpose: 'idle', workloadIds: [new mongoose.Types.ObjectId().toString()] }),
    });
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toMatchObject({ error: 'INVALID_WORKLOAD' });
  });

  it.skipIf(!HAS_MONGO)('T-IC5: accepts existing workloadIds and echoes them (201)', async () => {
    const db = await mongoDb();
    expect(db).not.toBeNull();

    const workloadId = new mongoose.Types.ObjectId();
    const now = new Date();
    await db!.collection('cloudworkloads').insertOne({
      _id: workloadId,
      name: `ic-workload-${Date.now().toString(36)}`,
      initScript: 'echo init',
      postScript: null,
      createdAt: now,
      updatedAt: now,
    });

    let containerId: string | null = null;
    try {
      // 去重保序（重复 ID 只保留一次）
      const res = await req('/internal/containers', {
        method: 'POST',
        body: JSON.stringify({ purpose: 'idle', workloadIds: [workloadId.toString(), workloadId.toString()] }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string; workloadIds: string[] };
      containerId = created.id;
      expect(created.workloadIds).toEqual([workloadId.toString()]);
    } finally {
      if (containerId) await req(`/internal/containers/${containerId}`, { method: 'DELETE' });
      await db!.collection('cloudworkloads').deleteOne({ _id: workloadId });
    }
  });

  it('T-IC7: workload-logs endpoint rejects a missing bearer with 401', async () => {
    const missing = await req('/internal/containers/whatever/workload-logs', {}, false);
    expect(missing.status).toBe(401);
  });

  it('T-IC6: workload-logs returns 404 for unknown; [] when the container has none', async () => {
    const unknown = await req('/internal/containers/nope/workload-logs');
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: 'NOT_FOUND' });

    const startRes = await req('/internal/containers', { method: 'POST', body: JSON.stringify({ purpose: 'idle' }) });
    const created = (await startRes.json()) as { id: string };
    try {
      const logs = await req(`/internal/containers/${created.id}/workload-logs`);
      expect(logs.status).toBe(200);
      expect(await logs.json()).toEqual([]);
    } finally {
      await req(`/internal/containers/${created.id}`, { method: 'DELETE' });
    }
  });

  it.skipIf(!HAS_MONGO)(
    'T-IC6: workload-logs returns records in execution order (A.6 fields)',
    async () => {
      const db = await mongoDb();
      expect(db).not.toBeNull();

      const startRes = await req('/internal/containers', { method: 'POST', body: JSON.stringify({ purpose: 'idle' }) });
      const created = (await startRes.json()) as { id: string };
      const containerId = new mongoose.Types.ObjectId(created.id);
      const workloadId = new mongoose.Types.ObjectId();
      const base = Date.now() - 60_000;

      await db!.collection('cloudworkloadlogs').insertMany([
        {
          containerId,
          workloadId,
          workloadName: 'setup-node',
          phase: 'init',
          status: 'success',
          script: 'echo init',
          params: { version: '20', package_manager: ['pnpm'] },
          required: true,
          exitCode: 0,
          log: 'init\n',
          startedAt: new Date(base),
          finishedAt: new Date(base + 1000),
          createdAt: new Date(base),
          updatedAt: new Date(base + 1000),
        },
        {
          containerId,
          workloadId,
          workloadName: 'teardown',
          phase: 'post',
          status: 'timeout',
          script: 'echo post',
          exitCode: null,
          log: '',
          startedAt: new Date(base + 2000),
          finishedAt: null,
          createdAt: new Date(base + 2000),
          updatedAt: new Date(base + 2000),
        },
      ]);

      try {
        const res = await req(`/internal/containers/${created.id}/workload-logs`);
        expect(res.status).toBe(200);
        const logs = (await res.json()) as Array<Record<string, unknown>>;
        expect(logs.map((l) => l.workloadName)).toEqual(['setup-node', 'teardown']);
        expect(logs.map((l) => l.phase)).toEqual(['init', 'post']);
        expect(logs.map((l) => l.status)).toEqual(['success', 'timeout']);
        expect(logs[0].script).toBe('echo init');
        // 参数快照随记录返回（A.6）；历史无 params 归一为 {}
        expect(logs[0].params).toEqual({ version: '20', package_manager: ['pnpm'] });
        expect(logs[1].params).toEqual({});
        // required 快照随记录返回（A.6）；历史缺省 false
        expect(logs[0].required).toBe(true);
        expect(logs[1].required).toBe(false);
        expect(logs[0].exitCode).toBe(0);
        expect(logs[1].exitCode).toBeNull();
        expect(logs[0].containerId).toBe(created.id);
        expect(logs[0].workloadId).toBe(workloadId.toString());
        expect(typeof logs[0].createdAt).toBe('string');
      } finally {
        await db!.collection('cloudworkloadlogs').deleteMany({ containerId });
        await req(`/internal/containers/${created.id}`, { method: 'DELETE' });
      }
    },
  );

  // -------------------------------------------------------------------------
  // 工作负载一期：workloadPlan 校验/落库/兜底展开（T-ICC1~T-ICC4）
  // -------------------------------------------------------------------------

  it.skipIf(!HAS_MONGO)('T-ICC1: accepts a workloadPlan and echoes it (201)', async () => {
    const db = await mongoDb();
    expect(db).not.toBeNull();

    const workloadId = await insertWorkload(db!);
    let containerId: string | null = null;
    try {
      const res = await req('/internal/containers', {
        method: 'POST',
        body: JSON.stringify({
          purpose: 'idle',
          workloadPlan: [{ workloadId: workloadId.toString(), params: { version: '20' }, implicit: false, required: true }],
        }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        id: string;
        workloadIds: string[];
        workloadPlan: Array<{ workloadId: string; params: Record<string, unknown>; implicit: boolean; required: boolean }>;
      };
      containerId = created.id;
      expect(created.workloadPlan).toEqual([
        { workloadId: workloadId.toString(), params: { version: '20' }, implicit: false, required: true },
      ]);
      // workloadIds 由 plan 派生
      expect(created.workloadIds).toEqual([workloadId.toString()]);
    } finally {
      if (containerId) await req(`/internal/containers/${containerId}`, { method: 'DELETE' });
      await db!.collection('cloudworkloads').deleteOne({ _id: workloadId });
    }
  });

  it.skipIf(!HAS_MONGO)('T-ICC2: rejects invalid workloadPlan with 400 INVALID_WORKLOAD', async () => {
    const db = await mongoDb();
    expect(db).not.toBeNull();

    const workloadId = await insertWorkload(db!);
    const valid = workloadId.toString();
    const cases: Array<{ label: string; body: unknown }> = [
      { label: '非数组', body: { purpose: 'idle', workloadPlan: 'nope' } },
      {
        label: '超过 10 条',
        body: {
          purpose: 'idle',
          workloadPlan: Array.from({ length: 11 }, () => ({
            workloadId: new mongoose.Types.ObjectId().toString(),
            params: {},
            implicit: false,
          })),
        },
      },
      {
        label: '未知 workloadId',
        body: {
          purpose: 'idle',
          workloadPlan: [
            { workloadId: new mongoose.Types.ObjectId().toString(), params: {}, implicit: false },
          ],
        },
      },
      { label: 'params 非对象', body: { purpose: 'idle', workloadPlan: [{ workloadId: valid, params: 'x', implicit: false }] } },
      { label: 'implicit 非布尔', body: { purpose: 'idle', workloadPlan: [{ workloadId: valid, params: {}, implicit: 'yes' }] } },
      { label: 'required 非布尔', body: { purpose: 'idle', workloadPlan: [{ workloadId: valid, params: {}, implicit: false, required: 'yes' }] } },
      { label: 'workloadId 缺失', body: { purpose: 'idle', workloadPlan: [{ params: {}, implicit: false }] } },
      { label: '条目非对象', body: { purpose: 'idle', workloadPlan: ['x'] } },
      {
        label: 'workloadId 重复',
        body: {
          purpose: 'idle',
          workloadPlan: [
            { workloadId: valid, params: {}, implicit: false },
            { workloadId: valid, params: {}, implicit: false },
          ],
        },
      },
    ];

    try {
      for (const testCase of cases) {
        const res = await req('/internal/containers', {
          method: 'POST',
          body: JSON.stringify(testCase.body),
        });
        expect(res.status, testCase.label).toBe(400);
        await expect(res.json(), testCase.label).resolves.toMatchObject({ error: 'INVALID_WORKLOAD' });
      }
    } finally {
      await db!.collection('cloudworkloads').deleteOne({ _id: workloadId });
    }
  });

  it.skipIf(!HAS_MONGO)(
    'T-ICC3: expands workloadIds-only requests with default params (fallback)',
    async () => {
      const db = await mongoDb();
      expect(db).not.toBeNull();

      const depId = await insertWorkload(db!, {
        paramSchema: [
          { key: 'version', label: '版本', type: 'text', options: [], defaultValue: '22' },
          {
            key: 'pm',
            label: '包管理器',
            type: 'multi_select',
            options: ['npm', 'pnpm'],
            // 默认值重复项应在归一后去重
            defaultValue: ['npm', 'npm'],
          },
        ],
      });
      const parentId = await insertWorkload(db!, { dependsOnWorkloadIds: [depId] });

      let containerId: string | null = null;
      try {
        const res = await req('/internal/containers', {
          method: 'POST',
          body: JSON.stringify({ purpose: 'idle', workloadIds: [parentId.toString()] }),
        });
        expect(res.status).toBe(201);
        const created = (await res.json()) as {
          id: string;
          workloadIds: string[];
          workloadPlan: Array<{ workloadId: string; params: Record<string, unknown>; implicit: boolean }>;
        };
        containerId = created.id;
        // 契约 A.2.2：仅 workloadIds 的旧版请求按选择顺序落库（不含隐式依赖）
        expect(created.workloadIds).toEqual([parentId.toString()]);
        // 兜底展开得到的 plan 仅用于执行（依赖先于依赖方、隐式项取默认参数且多选去重；
        // required 一律 false —— 旧请求无必须语义）
        expect(created.workloadPlan).toEqual([
          { workloadId: depId.toString(), params: { version: '22', pm: ['npm'] }, implicit: true, required: false },
          { workloadId: parentId.toString(), params: {}, implicit: false, required: false },
        ]);
      } finally {
        if (containerId) await req(`/internal/containers/${containerId}`, { method: 'DELETE' });
        await db!.collection('cloudworkloads').deleteMany({ _id: { $in: [depId, parentId] } });
      }
    },
  );

  it.skipIf(!HAS_MONGO)('T-ICC4: prefers workloadPlan over the provided workloadIds', async () => {
    const db = await mongoDb();
    expect(db).not.toBeNull();

    const planId = await insertWorkload(db!);
    const otherId = await insertWorkload(db!);

    let containerId: string | null = null;
    try {
      const res = await req('/internal/containers', {
        method: 'POST',
        body: JSON.stringify({
          purpose: 'idle',
          workloadIds: [otherId.toString()],
          workloadPlan: [{ workloadId: planId.toString(), params: {}, implicit: false }],
        }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        id: string;
        workloadIds: string[];
        workloadPlan: Array<{ workloadId: string }>;
      };
      containerId = created.id;
      // 以 plan 派生的 workloadIds 为准
      expect(created.workloadIds).toEqual([planId.toString()]);
      expect(created.workloadPlan.map((entry) => entry.workloadId)).toEqual([planId.toString()]);
    } finally {
      if (containerId) await req(`/internal/containers/${containerId}`, { method: 'DELETE' });
      await db!.collection('cloudworkloads').deleteMany({ _id: { $in: [planId, otherId] } });
    }
  });

  it.skipIf(!HAS_MONGO)('T-ICC5: normalizes plan entries missing params/implicit', async () => {
    const db = await mongoDb();
    expect(db).not.toBeNull();

    const workloadId = await insertWorkload(db!);
    let containerId: string | null = null;
    try {
      const res = await req('/internal/containers', {
        method: 'POST',
        body: JSON.stringify({
          purpose: 'idle',
          workloadPlan: [{ workloadId: workloadId.toString() }],
        }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        id: string;
        workloadPlan: Array<{ workloadId: string; params: Record<string, unknown>; implicit: boolean }>;
      };
      containerId = created.id;
      expect(created.workloadPlan).toEqual([
        { workloadId: workloadId.toString(), params: {}, implicit: false, required: false },
      ]);
    } finally {
      if (containerId) await req(`/internal/containers/${containerId}`, { method: 'DELETE' });
      await db!.collection('cloudworkloads').deleteOne({ _id: workloadId });
    }
  });

  it.skipIf(!HAS_MONGO)(
    'T-ICC6: maps fallback expansion failures (cycle / missing dep / >10) to 400 INVALID_WORKLOAD',
    async () => {
      const db = await mongoDb();
      expect(db).not.toBeNull();

      // 环：a ↔ b
      const cycA = await insertWorkload(db!);
      const cycB = await insertWorkload(db!, { dependsOnWorkloadIds: [cycA] });
      await db!
        .collection('cloudworkloads')
        .updateOne({ _id: cycA }, { $set: { dependsOnWorkloadIds: [cycB] } });
      // 依赖缺失：指向不存在的 ID
      const orphan = await insertWorkload(db!, {
        dependsOnWorkloadIds: [new mongoose.Types.ObjectId()],
      });
      // 展开超 10：父依赖 10 个子项 + 自身 = 11
      const children: mongoose.Types.ObjectId[] = [];
      for (let i = 0; i < 10; i += 1) children.push(await insertWorkload(db!));
      const big = await insertWorkload(db!, { dependsOnWorkloadIds: children });

      const allIds = [cycA, cycB, orphan, big, ...children];
      try {
        const cases: Array<[string, mongoose.Types.ObjectId]> = [
          ['dependency cycle', cycA],
          ['missing dependency', orphan],
          ['expanded > 10', big],
        ];
        for (const [label, workloadId] of cases) {
          const res = await req('/internal/containers', {
            method: 'POST',
            body: JSON.stringify({ purpose: 'idle', workloadIds: [workloadId.toString()] }),
          });
          expect(res.status, label).toBe(400);
          await expect(res.json(), label).resolves.toMatchObject({ error: 'INVALID_WORKLOAD' });
        }
      } finally {
        await db!.collection('cloudworkloads').deleteMany({ _id: { $in: allIds } });
      }
    },
  );

  it.skipIf(!HAS_MONGO)(
    'T-ICC7: normalizes plan.required (missing/null→false, true preserved) and rejects non-boolean',
    async () => {
      const db = await mongoDb();
      expect(db).not.toBeNull();

      const mustId = await insertWorkload(db!);
      const optId = await insertWorkload(db!);
      let containerId: string | null = null;
      try {
        const res = await req('/internal/containers', {
          method: 'POST',
          body: JSON.stringify({
            purpose: 'idle',
            workloadPlan: [
              { workloadId: mustId.toString(), params: {}, implicit: false, required: true },
              { workloadId: optId.toString(), params: {}, implicit: false },
            ],
          }),
        });
        expect(res.status).toBe(201);
        const created = (await res.json()) as {
          id: string;
          workloadPlan: Array<{ workloadId: string; required: boolean }>;
        };
        containerId = created.id;
        expect(created.workloadPlan).toEqual([
          { workloadId: mustId.toString(), params: {}, implicit: false, required: true },
          { workloadId: optId.toString(), params: {}, implicit: false, required: false },
        ]);

        // required: null 归一 false
        const nullRes = await req('/internal/containers', {
          method: 'POST',
          body: JSON.stringify({
            purpose: 'idle',
            workloadPlan: [{ workloadId: optId.toString(), params: {}, implicit: false, required: null }],
          }),
        });
        expect(nullRes.status).toBe(201);
        const nullCreated = (await nullRes.json()) as {
          id: string;
          workloadPlan: Array<{ required: boolean }>;
        };
        expect(nullCreated.workloadPlan[0]!.required).toBe(false);
        await req(`/internal/containers/${nullCreated.id}`, { method: 'DELETE' });
      } finally {
        if (containerId) await req(`/internal/containers/${containerId}`, { method: 'DELETE' });
        await db!.collection('cloudworkloads').deleteMany({ _id: { $in: [mustId, optId] } });
      }
    },
  );

  it.skipIf(!HAS_MONGO)('T-ICC8: workloadIds-only fallback expansion sets required=false', async () => {
    const db = await mongoDb();
    expect(db).not.toBeNull();

    const workloadId = await insertWorkload(db!);
    let containerId: string | null = null;
    try {
      const res = await req('/internal/containers', {
        method: 'POST',
        body: JSON.stringify({ purpose: 'idle', workloadIds: [workloadId.toString()] }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        id: string;
        workloadPlan: Array<{ required: boolean }>;
      };
      containerId = created.id;
      expect(created.workloadPlan.every((entry) => entry.required === false)).toBe(true);
    } finally {
      if (containerId) await req(`/internal/containers/${containerId}`, { method: 'DELETE' });
      await db!.collection('cloudworkloads').deleteOne({ _id: workloadId });
    }
  });
});

// Phase 4：通过真实 Job manifest 构造断言 ephemeral-storage（无需 K8s 集群）
describe('cloud-controller Job manifest resources', () => {
  const build = (ephemeralStorage?: string) => {
    const manager = new K8sJobManager(new InMemoryK8sClient(), {
      namespace: 'zag-workers',
      image: 'worker:1.0.0',
      runtimeClassName: 'sysbox-runc',
      publicWsEndpoint: 'cloud.example.com:4003',
      ...(ephemeralStorage ? { ephemeralStorage } : {}),
    });
    return manager.buildManifest({
      jobName: 'zag-worker-e2e',
      containerId: 'container-e2e',
      token: 'container-e2e.secret',
    });
  };

  it('T-IC-EPH1: 仅声明 limits ephemeral-storage: 10Gi（不设 requests）', () => {
    const resources = build().spec.template.spec.containers[0]!.resources;
    expect(resources.requests).toBeUndefined();
    expect(resources.limits['ephemeral-storage']).toBe('10Gi');
  });

  it('T-IC-EPH2: JOB_EPHEMERAL_STORAGE 覆盖值仅作用于 limits', () => {
    const resources = build('5Gi').spec.template.spec.containers[0]!.resources;
    expect(resources.requests).toBeUndefined();
    expect(resources.limits['ephemeral-storage']).toBe('5Gi');
  });
});
