import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';

// cloud-controller 存储级归档/复原（契约附录 A.2.3 / A.2.11 ~ A.2.13）。
// Aspire 以 K8S_ENABLED=false 启动，PVC/Job 走 InMemory 实现（Job 不会自动完成）。
const BASE = (process.env.CLOUD_CONTROLLER_URL || 'http://localhost:10004').replace(/\/+$/, '');
const TOKEN = process.env.CLOUD_CONTROLLER_INTERNAL_TOKEN;
const MONGO_URI = process.env.MONGODB_URI;

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

function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return req(path, { method: 'POST', body: JSON.stringify(body) });
}

describe.skipIf(!TOKEN)('cloud-controller storage operations API', () => {
  it('T-AR4/T-RS4: 存储级 archive/restore 受理、operations 查询、幂等与 409 OPERATION_RUNNING', async () => {
    const archiveStorageId = oid();
    const restoreStorageId = oid();
    const workspaceId = oid();
    const tenantId = oid();
    const operationId = oid();
    const secondOperationId = oid();

    for (const storageId of [archiveStorageId, restoreStorageId]) {
      const created = await post('/internal/storages', {
        storageId,
        tenantId,
        workspaceId,
        sizeGi: 10,
      });
      expect(created.status).toBe(200);
    }

    // 存储级归档：受理 + 台账可查
    const archived = await post(`/internal/storages/${archiveStorageId}/archive`, {
      operationId,
      archiveId: oid(),
      fileName: 'manual-20261102-153012.tar.gz2',
      workspaceId,
      tenantId,
    });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ accepted: true, operationId });

    const listed = await req(`/internal/storages/${archiveStorageId}/operations/${operationId}`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      operationId,
      type: 'archive',
      status: expect.stringMatching(/^(pending|running|succeeded|failed)$/),
    });

    // 同 operationId 重投幂等；同存储新单 → 409 OPERATION_RUNNING
    const repeated = await post(`/internal/storages/${archiveStorageId}/archive`, {
      operationId,
      archiveId: oid(),
      fileName: 'manual-20261102-153013.tar.gz2',
      workspaceId,
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ accepted: true, operationId });

    const conflict = await post(`/internal/storages/${archiveStorageId}/archive`, {
      operationId: secondOperationId,
      archiveId: oid(),
      fileName: 'manual-20261102-153014.tar.gz2',
      workspaceId,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'OPERATION_RUNNING' });

    // 非法 operationId → 400 INVALID_BODY（路由前置校验）
    const invalid = await post(`/internal/storages/${archiveStorageId}/archive`, {
      operationId: 'not-hex',
      archiveId: oid(),
      fileName: 'manual-20261102-153015.tar.gz2',
      workspaceId,
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'INVALID_BODY' });

    // 存储级复原：受理 + 台账可查（目标 PVC 由服务重建；归档卷缺失时 Job 失败但端点已受理）
    const restoreOperationId = oid();
    const restored = await post(`/internal/storages/${restoreStorageId}/restore`, {
      operationId: restoreOperationId,
      workspaceId,
      tenantId,
      archivePath: `/archive/${workspaceId}/${archiveStorageId}/manual-20261102-153012.tar.gz2`,
      sizeGi: 10,
      storageClass: 'ceph-rbd',
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({
      accepted: true,
      operationId: restoreOperationId,
    });
    const restoreListed = await req(
      `/internal/storages/${restoreStorageId}/operations/${restoreOperationId}`,
    );
    expect(restoreListed.status).toBe(200);
    expect(await restoreListed.json()).toMatchObject({
      operationId: restoreOperationId,
      type: 'restore',
      status: expect.stringMatching(/^(pending|running|succeeded|failed)$/),
    });
  });

  it.skipIf(!MONGO_URI)(
    'T-SKIP4: DELETE storageArchive:false 在终态前落 storageArchiveSkipped，且 terminal 报文按需携带',
    async () => {
      // 通过内部 API 创建一个 idle 容器，再直写挂载存储字段（等价 harness 落库）。
      const created = await post('/internal/containers', { purpose: 'idle' });
      expect(created.status).toBe(201);
      const container = (await created.json()) as { id: string };
      const storageId = oid();
      const workspaceId = oid();
      const tenantId = oid();
      await mongoose.connect(MONGO_URI!);
      await mongoose.connection.collection('cloudcontainers').updateOne(
        { _id: new mongoose.Types.ObjectId(container.id) },
        {
          $set: {
            purpose: 'harness',
            hostId: oid(),
            status: 'online',
            connectedAt: new Date(),
            storageId,
            storagePvcName: `zag-storage-${storageId}`,
            storageWorkspaceId: workspaceId,
            storageSizeGi: 10,
          },
        },
      );

      const destroyed = await req(`/internal/containers/${container.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ storageArchive: false }),
      });
      expect(destroyed.status).toBe(200);

      const doc = await mongoose.connection
        .collection('cloudcontainers')
        .findOne({ _id: new mongoose.Types.ObjectId(container.id) });
      expect(doc?.status).toBe('exited');
      expect(doc?.storageArchiveSkipped).toBe(true);
      expect(doc?.storageArchiveStatus ?? null).toBeNull();
    },
    30_000,
  );

  it('T-AR4: destroy storageArchive 非布尔 → 400 INVALID_BODY', async () => {
    const created = await post('/internal/containers', { purpose: 'idle' });
    expect(created.status).toBe(201);
    const container = (await created.json()) as { id: string };
    const response = await req(`/internal/containers/${container.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ storageArchive: 'no' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'INVALID_BODY' });
  });
});
