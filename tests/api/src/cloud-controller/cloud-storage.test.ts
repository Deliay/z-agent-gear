import { describe, it, expect } from 'vitest';

// cloud-controller 云存储内部 API（契约附录 A.2.7~A.2.10）。
// Aspire 以 K8S_ENABLED=false 启动，PVC/Job 走 InMemory 实现。
const BASE = process.env.CLOUD_CONTROLLER_URL || 'http://localhost:10004';
const TOKEN = process.env.CLOUD_CONTROLLER_INTERNAL_TOKEN;

function req(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

function oid(): string {
  let out = '';
  for (let i = 0; i < 24; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

describe.skipIf(!TOKEN)('cloud-controller storage API', () => {
  it('T-CC-P2/P3: PVC provision is idempotent, conflicting specs are rejected', async () => {
    const storageId = oid();
    const workspaceId = oid();
    const tenantId = oid();

    const created = await req('/internal/storages', {
      method: 'POST',
      body: JSON.stringify({ storageId, tenantId, workspaceId, sizeGi: 10 }),
    });
    expect(created.status).toBe(200);
    const first = (await created.json()) as { storageId: string; pvcName: string; created: boolean };
    expect(first).toMatchObject({ storageId, pvcName: `zag-storage-${storageId}`, created: true });

    const again = await req('/internal/storages', {
      method: 'POST',
      body: JSON.stringify({ storageId, tenantId, workspaceId, sizeGi: 10 }),
    });
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({ created: false });

    const conflict = await req('/internal/storages', {
      method: 'POST',
      body: JSON.stringify({ storageId, tenantId, workspaceId, sizeGi: 20 }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: 'STORAGE_PVC_CONFLICT' });

    const detail = await req(`/internal/storages/${storageId}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      storageId,
      exists: true,
      capacity: '10Gi',
    });

    const removed = await req(`/internal/storages/${storageId}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({ deleted: true });

    // 404 幂等
    const removedAgain = await req(`/internal/storages/${storageId}`, { method: 'DELETE' });
    expect(removedAgain.status).toBe(200);
  });

  it('T-CC-P3: invalid storage request is rejected without creating a PVC', async () => {
    const badSize = await req('/internal/storages', {
      method: 'POST',
      body: JSON.stringify({ storageId: oid(), workspaceId: oid(), sizeGi: 31 }),
    });
    expect(badSize.status).toBe(400);

    const badClass = await req('/internal/storages', {
      method: 'POST',
      body: JSON.stringify({
        storageId: oid(),
        workspaceId: oid(),
        sizeGi: 10,
        storageClass: 'Bad Class!',
      }),
    });
    expect(badClass.status).toBe(400);
  });

  it('T-CC-D1: cleanup deletes the source PVC and is idempotent', async () => {
    const storageId = oid();
    const workspaceId = oid();
    await req('/internal/storages', {
      method: 'POST',
      body: JSON.stringify({ storageId, workspaceId, sizeGi: 5 }),
    });

    const cleaned = await req(`/internal/storages/${storageId}/cleanup`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId, deleteArchive: true }),
    });
    expect(cleaned.status).toBe(200);
    await expect(cleaned.json()).resolves.toMatchObject({ accepted: true });

    const detail = await req(`/internal/storages/${storageId}`);
    await expect(detail.json()).resolves.toMatchObject({ exists: false });
  });

  it('T-CC-AR1/AR2: archive endpoints require a storage-mounted container', async () => {
    const started = await req('/internal/containers', {
      method: 'POST',
      body: JSON.stringify({ purpose: 'idle' }),
    });
    expect(started.status).toBe(201);
    const container = (await started.json()) as { id: string };

    const archive = await req(`/internal/containers/${container.id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archiveId: oid(), fileName: 'my-host-20261102-153012.tar.gz2' }),
    });
    expect(archive.status).toBe(409);
    await expect(archive.json()).resolves.toMatchObject({ error: 'NO_STORAGE' });

    const status = await req(`/internal/containers/${container.id}/archive`);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ status: 'NONE', archiveId: null });

    const missing = await req(`/internal/containers/${oid()}/archive`);
    expect(missing.status).toBe(404);

    await req(`/internal/containers/${container.id}`, { method: 'DELETE' });
  });

  it('T-CC-J3: harness storage payload validation', async () => {
    const base = {
      purpose: 'harness',
      hostId: oid(),
      refId: oid(),
      userId: oid(),
      hostName: 'api-test',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      agentGearMinVersion: '2.12.0',
      harnessTypes: [],
      secrets: {
        hostEndpoint: 'wss://controller.invalid',
        hostKey: 'zag_k_test',
        modelApiKey: 'zag_sk_test',
        modelBaseUrl: 'http://admin-api:8002/v1',
        modelIds: '[]',
        defaultWorkspace: '/home/worker/workspace',
      },
    };

    const badName = await req('/internal/containers', {
      method: 'POST',
      body: JSON.stringify({
        ...base,
        storage: {
          id: oid(),
          pvcName: 'not-a-zag-storage',
          sizeGi: 10,
          workspaceId: oid(),
        },
      }),
    });
    expect(badName.status).toBe(400);

    const badSize = await req('/internal/containers', {
      method: 'POST',
      body: JSON.stringify({
        ...base,
        storage: {
          id: oid(),
          pvcName: `zag-storage-${oid()}`,
          sizeGi: 31,
          workspaceId: oid(),
        },
      }),
    });
    expect(badSize.status).toBe(400);

    const badRestore = await req('/internal/containers', {
      method: 'POST',
      body: JSON.stringify({
        ...base,
        storage: {
          id: oid(),
          pvcName: `zag-storage-${oid()}`,
          sizeGi: 10,
          workspaceId: oid(),
          restore: { archivePath: '/archive/../../etc/passwd.tar.gz2' },
        },
      }),
    });
    expect(badRestore.status).toBe(400);
  });
});
