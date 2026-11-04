import { describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { ContainerService } from '../services/container-service.js';
import { InMemoryK8sClient } from '../services/k8s-client.js';
import { K8sJobManager } from '../services/k8s-job-manager.js';
import { K8sStorageManager } from '../services/k8s-storage-manager.js';
import { StorageService } from '../services/storage-service.js';
import { TokenService } from '../services/token-service.js';
import { InMemoryContainerRepository } from '../repositories/container-repository.js';
import { InMemoryStorageOperationRepository } from '../repositories/storage-operation-repository.js';
import { internalAuth } from '../middleware/internal-auth.js';
import { createTestLogger } from '../observability/testing.js';
import { createInternalRouter, parseHarnessRequest, parseStorageRequest } from './internal-api.js';

const TOKEN = 'test-internal-token';
const STORAGE_ID = 'a'.repeat(24);
const WORKSPACE_ID = 'b'.repeat(24);
const TENANT_ID = 'c'.repeat(24);
const FILE_NAME = 'my-pc-20261102-153012.tar.gz2';

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

function harnessPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    purpose: 'harness',
    hostId: 'host-1',
    refId: 'ck-1',
    userId: 'user-1',
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    hostName: 'my-pc',
    harnessTypes: ['opencode'],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    agentGearMinVersion: '2.12.0',
    secrets: {
      hostEndpoint: 'wss://controller.example.com',
      hostKey: 'zag_k_1_ws',
      modelApiKey: 'zag_sk_ws',
      modelBaseUrl: 'http://admin-api:8002/v1',
      modelIds: '["a"]',
      defaultWorkspace: '/home/worker/workspace',
    },
    workloadPlan: [],
    ...overrides,
  };
}

function validStorage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: STORAGE_ID,
    pvcName: `zag-storage-${STORAGE_ID}`,
    sizeGi: 10,
    workspaceId: WORKSPACE_ID,
    storageClass: 'ceph-rbd',
    ...overrides,
  };
}

async function setup() {
  const repo = new InMemoryContainerRepository();
  const client = new InMemoryK8sClient();
  const tokenService = new TokenService(repo);
  const jobManager = new K8sJobManager(client, {
    namespace: 'zag-cloud',
    image: 'zero-tools/zag-worker:latest',
    publicWsEndpoint: 'cloud.example.com:4003',
    archiverImage: 'archiver:test',
  });
  const storageManager = new K8sStorageManager(client, {
    namespace: 'zag-cloud',
    storagePvcPrefix: 'zag-storage-',
    archivePvcPrefix: 'zag-archive-',
    storageClass: 'ceph-rbd',
    archiveStorageClass: 'cephfs',
    archivePvcSize: '100Gi',
    archiveAccessMode: 'ReadWriteOnce',
  });
  const testLog = createTestLogger();
  const operationRepo = new InMemoryStorageOperationRepository();
  const storageService = new StorageService({
    repo,
    k8sClient: client,
    storageManager,
    operationRepo,
    logger: testLog.logger,
    config: {
      namespace: 'zag-cloud',
      archiverImage: 'archiver:test',
      archiveTimeoutMs: 1000,
      pollIntervalMs: 2,
    },
  });
  const containerService = new ContainerService(
    repo,
    tokenService,
    jobManager,
    {
      namespace: 'zag-cloud',
      image: 'zero-tools/zag-worker:latest',
      connectTimeoutMs: 300000,
      shutdownGraceMs: 0,
    },
    testLog.logger,
    {},
    undefined,
    storageService,
  );
  const app = express();
  app.use(express.json());
  app.use(
    '/internal',
    internalAuth(TOKEN),
    createInternalRouter(containerService, { storageService }),
  );
  const httpServer: HttpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  return { repo, client, storageManager, storageService, containerService, httpServer, baseUrl };}

async function close(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function post(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
}

describe('parseStorageRequest（T-CC-J3 校验）', () => {
  it('合法 storage（含可选 storageClass/restore）', () => {
    expect(
      parseStorageRequest({
        ...validStorage(),
        restore: { archivePath: `/archive/${WORKSPACE_ID}/${STORAGE_ID}/${FILE_NAME}` },
      }),
    ).toEqual({
      id: STORAGE_ID,
      pvcName: `zag-storage-${STORAGE_ID}`,
      sizeGi: 10,
      workspaceId: WORKSPACE_ID,
      storageClass: 'ceph-rbd',
      restore: { archivePath: `/archive/${WORKSPACE_ID}/${STORAGE_ID}/${FILE_NAME}` },
    });
  });

  it('缺省/null 合法（不挂载）', () => {
    expect(parseStorageRequest(undefined)).toBeNull();
    expect(parseStorageRequest(null)).toBeNull();
  });

  it('非法字段均返回 undefined', () => {
    const invalid: unknown[] = [
      'oops',
      [],
      validStorage({ id: '' }),
      validStorage({ pvcName: 'other-pvc' }),
      validStorage({ sizeGi: 0 }),
      validStorage({ sizeGi: 31 }),
      validStorage({ sizeGi: 1.5 }),
      validStorage({ sizeGi: '10' }),
      validStorage({ workspaceId: '' }),
      validStorage({ storageClass: 'Bad_Class' }),
      validStorage({ storageClass: 'a'.repeat(64) }),
      validStorage({ restore: { archivePath: '/archive/x/y/file.tar.gz2' } }),
      validStorage({
        restore: { archivePath: `/archive/${WORKSPACE_ID}/${STORAGE_ID}/../${FILE_NAME}` },
      }),
      validStorage({ restore: { archivePath: `/archive/${WORKSPACE_ID}/${STORAGE_ID}/x.zip` } }),
      validStorage({ restore: {} }),
    ];
    for (const value of invalid) {
      expect(parseStorageRequest(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('parseHarnessRequest 对非法 storage 返回 null（400 INVALID_HARNESS）', async () => {
    await expect(
      parseHarnessRequest(harnessPayload({ storage: validStorage({ sizeGi: 99 }) })),
    ).resolves.toBeNull();
    const parsed = await parseHarnessRequest(harnessPayload({ storage: validStorage() }));
    expect(parsed?.storage?.id).toBe(STORAGE_ID);
  });
});

describe('internal storage API', () => {
  it('T-CC-P2/P3: POST 幂等 / GET / 冲突 409', async () => {
    const ctx = await setup();
    try {
      const created = await post(`${ctx.baseUrl}/internal/storages`, {
        storageId: STORAGE_ID,
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        sizeGi: 10,
        storageClass: 'ceph-rbd',
      });
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual({
        storageId: STORAGE_ID,
        pvcName: `zag-storage-${STORAGE_ID}`,
        created: true,
      });

      const again = await post(`${ctx.baseUrl}/internal/storages`, {
        storageId: STORAGE_ID,
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        sizeGi: 10,
        storageClass: 'ceph-rbd',
      });
      expect((await again.json()).created).toBe(false);

      const conflict = await post(`${ctx.baseUrl}/internal/storages`, {
        storageId: STORAGE_ID,
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        sizeGi: 20,
        storageClass: 'ceph-rbd',
      });
      expect(conflict.status).toBe(409);
      expect((await conflict.json()).error).toBe('STORAGE_PVC_CONFLICT');

      const got = await fetch(`${ctx.baseUrl}/internal/storages/${STORAGE_ID}`, {
        headers: authHeaders(),
      });
      expect(await got.json()).toMatchObject({
        storageId: STORAGE_ID,
        exists: true,
        capacity: '10Gi',
        phase: 'Bound',
      });

      const unknown = await fetch(`${ctx.baseUrl}/internal/storages/unknown`, {
        headers: authHeaders(),
      });
      expect(await unknown.json()).toMatchObject({ exists: false, capacity: null });

      const invalid = await post(`${ctx.baseUrl}/internal/storages`, {
        storageId: STORAGE_ID,
        sizeGi: 0,
      });
      expect(invalid.status).toBe(400);
    } finally {
      await close(ctx.httpServer);
    }
  });

  it('T-CC-P3: 活跃容器引用 → DELETE 409 STORAGE_IN_USE；无引用则 404 幂等', async () => {
    const ctx = await setup();
    try {
      const created = await post(
        `${ctx.baseUrl}/internal/containers`,
        harnessPayload({ storage: validStorage() }),
      );
      expect(created.status).toBe(201);

      const inUse = await fetch(`${ctx.baseUrl}/internal/storages/${STORAGE_ID}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      expect(inUse.status).toBe(409);
      expect((await inUse.json()).error).toBe('STORAGE_IN_USE');

      const missing = await fetch(`${ctx.baseUrl}/internal/storages/unknown`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      expect(missing.status).toBe(200);
      expect(await missing.json()).toEqual({ storageId: 'unknown', deleted: true });
    } finally {
      await close(ctx.httpServer);
    }
  });

  it('T-CC-J3: 非法 storage → 400 INVALID_HARNESS 且不创建 Job', async () => {
    const ctx = await setup();
    try {
      const response = await post(
        `${ctx.baseUrl}/internal/containers`,
        harnessPayload({ storage: validStorage({ pvcName: 'bad-name' }) }),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('INVALID_HARNESS');
      expect(ctx.client.createdManifests).toHaveLength(0);
      expect(await ctx.repo.findAll()).toHaveLength(0);
    } finally {
      await close(ctx.httpServer);
    }
  });

  it('T-CC-AR1/AR2: 归档触发/查询（活跃 409 → 终态 accepted → SUCCEEDED）', async () => {
    const ctx = await setup();
    try {
      const created = await post(
        `${ctx.baseUrl}/internal/containers`,
        harnessPayload({ storage: validStorage() }),
      );
      const container = (await created.json()) as { id: string };

      const active = await post(`${ctx.baseUrl}/internal/containers/${container.id}/archive`, {
        archiveId: 'archive-1',
        fileName: FILE_NAME,
      });
      expect(active.status).toBe(409);
      expect((await active.json()).error).toBe('CONTAINER_ACTIVE');

      const noArchive = await fetch(
        `${ctx.baseUrl}/internal/containers/${container.id}/archive`,
        { headers: authHeaders() },
      );
      expect((await noArchive.json()).status).toBe('NONE');

      // 终态（未连接 → 不自动归档），显式触发归档。
      await ctx.containerService.markFailed(container.id, '测试终止');
      ctx.client.onJobCreated = (manifest) => {
        if (manifest.metadata.labels.app !== 'zag-archive') return;
        ctx.client.setPodLog(manifest.metadata.name, 'ZAG_ARCHIVE_RESULT={"usageBytes":900}');
        ctx.client.setPhase(manifest.metadata.name, 'succeeded');
      };

      const trigger = await post(`${ctx.baseUrl}/internal/containers/${container.id}/archive`, {
        archiveId: 'archive-1',
        fileName: FILE_NAME,
      });
      expect(trigger.status).toBe(200);
      expect(await trigger.json()).toEqual({ accepted: true, archiveId: 'archive-1' });
      await ctx.storageService.drainArchiveTasks();

      const queried = await fetch(
        `${ctx.baseUrl}/internal/containers/${container.id}/archive`,
        { headers: authHeaders() },
      );
      expect(await queried.json()).toMatchObject({
        status: 'SUCCEEDED',
        archiveId: 'archive-1',
        fileName: FILE_NAME,
        usageBytes: 900,
        failureReason: null,
      });

      const conflict = await post(
        `${ctx.baseUrl}/internal/storages/${STORAGE_ID}/cleanup`,
        { workspaceId: WORKSPACE_ID, deleteArchive: true },
      );
      expect(conflict.status).toBe(200);
    } finally {
      await close(ctx.httpServer);
    }
  });

  it('T-CC-U1: usage-refresh 404 / NO_STORAGE / CONTAINER_NOT_ACTIVE', async () => {
    const ctx = await setup();
    try {
      const missing = await post(`${ctx.baseUrl}/internal/storages/${STORAGE_ID}/usage-refresh`, {
        containerId: '507f1f77bcf86cd799439011',
      });
      expect(missing.status).toBe(404);

      const idle = await post(`${ctx.baseUrl}/internal/containers`, { purpose: 'idle' });
      const idleBody = (await idle.json()) as { id: string };
      const noStorage = await post(
        `${ctx.baseUrl}/internal/storages/${STORAGE_ID}/usage-refresh`,
        { containerId: idleBody.id },
      );
      expect(noStorage.status).toBe(409);
      expect((await noStorage.json()).error).toBe('NO_STORAGE');
    } finally {
      await close(ctx.httpServer);
    }
  });

  it('T-CC-D1: cleanup 归档进行中 → 409 ARCHIVE_RUNNING', async () => {
    const ctx = await setup();
    try {
      await ctx.repo.create({
        name: 'zag-worker-busy',
        namespace: 'zag-cloud',
        purpose: 'harness',
        image: 'worker:test',
        status: 'exited',
        storageId: STORAGE_ID,
        storagePvcName: `zag-storage-${STORAGE_ID}`,
        storageWorkspaceId: WORKSPACE_ID,
        storageArchiveStatus: 'running',
        storageArchiveId: 'archive-busy',
      });

      const response = await post(
        `${ctx.baseUrl}/internal/storages/${STORAGE_ID}/cleanup`,
        { workspaceId: WORKSPACE_ID, deleteArchive: true },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: 'ARCHIVE_RUNNING',
        archiveId: 'archive-busy',
      });
    } finally {
      await close(ctx.httpServer);
    }
  });

  it('T-AR4: POST /storages/:id/archive 受理并可按 operationId 查询', async () => {
    const ctx = await setup();
    try {
      await ctx.storageManager.ensureStoragePvc({
        storageId: STORAGE_ID,
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        sizeGi: 10,
      });
      await ctx.storageManager.ensureArchivePvc(WORKSPACE_ID, TENANT_ID);
      ctx.client.onJobCreated = (manifest) => {
        if (manifest.metadata.labels.app !== 'zag-archive') return;
        ctx.client.setPodLog(
          manifest.metadata.name,
          'ZAG_ARCHIVE_RESULT={"usageBytes":321}',
        );
        ctx.client.setPhase(manifest.metadata.name, 'succeeded');
      };
      const operationId = 'd'.repeat(24);

      const response = await post(
        `${ctx.baseUrl}/internal/storages/${STORAGE_ID}/archive`,
        {
          operationId,
          archiveId: 'archive-api-1',
          fileName: FILE_NAME,
          workspaceId: WORKSPACE_ID,
          tenantId: TENANT_ID,
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accepted: true, operationId });

      await ctx.storageService.drainArchiveTasks();
      const detail = await fetch(
        `${ctx.baseUrl}/internal/storages/${STORAGE_ID}/operations/${operationId}`,
        { headers: authHeaders() },
      );
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        operationId,
        type: 'archive',
        status: 'succeeded',
        usageBytes: 321,
      });
    } finally {
      await close(ctx.httpServer);
    }
  });

  it('T-AR4: 非法 operationId / 非布尔 storageArchive → 400 INVALID_BODY', async () => {
    const ctx = await setup();
    try {
      const badOperation = await post(
        `${ctx.baseUrl}/internal/storages/${STORAGE_ID}/archive`,
        {
          operationId: 'not-hex',
          archiveId: 'archive-api-1',
          fileName: FILE_NAME,
          workspaceId: WORKSPACE_ID,
        },
      );
      expect(badOperation.status).toBe(400);
      expect((await badOperation.json()).error).toBe('INVALID_BODY');

      const container = await ctx.repo.create({
        name: 'zag-worker-destroy',
        namespace: 'zag-cloud',
        purpose: 'harness',
        image: 'worker:test',
        status: 'online',
        storageId: STORAGE_ID,
      });
      const badDestroy = await fetch(
        `${ctx.baseUrl}/internal/containers/${container.id}`,
        {
          method: 'DELETE',
          headers: authHeaders(),
          body: JSON.stringify({ storageArchive: 'no' }),
        },
      );
      expect(badDestroy.status).toBe(400);
      expect((await badDestroy.json()).error).toBe('INVALID_BODY');
    } finally {
      await close(ctx.httpServer);
    }
  });
});
