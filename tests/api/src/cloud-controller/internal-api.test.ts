import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';

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
});
