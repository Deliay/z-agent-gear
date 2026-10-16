import { describe, it, expect } from 'vitest';

// cloud-controller 内部管理 REST（契约附录 A）。由 Aspire 以 K8S_ENABLED=false 启动。
// INTERNAL_API_TOKEN 已无公开默认值（问题 47）：须经环境注入，未提供时显式跳过而非静默假绿。
const BASE = process.env.CLOUD_CONTROLLER_URL || 'http://localhost:10004';
const TOKEN = process.env.CLOUD_CONTROLLER_INTERNAL_TOKEN;

function req(path: string, init: RequestInit = {}, withAuth = true): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) };
  if (withAuth) headers.Authorization = `Bearer ${TOKEN}`;
  return fetch(`${BASE}${path}`, { ...init, headers });
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
});
