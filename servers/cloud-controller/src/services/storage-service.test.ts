import { describe, expect, it } from 'vitest';
import { InMemoryK8sClient } from './k8s-client.js';
import { K8sStorageManager } from './k8s-storage-manager.js';
import {
  ContainerActiveError,
  OperationRunningError,
  StorageArchiveRunningError,
  StorageService,
  buildArchiveScript,
  parseUsageBytes,
  type ArchiveCallbackPayload,
  type RestoreCallbackPayload,
  type UsageCallbackPayload,
} from './storage-service.js';
import { InMemoryContainerRepository } from '../repositories/container-repository.js';
import { InMemoryStorageOperationRepository } from '../repositories/storage-operation-repository.js';
import { createTestLogger } from '../observability/testing.js';

const STORAGE_ID = 'a'.repeat(24);
const WORKSPACE_ID = 'b'.repeat(24);
const TENANT_ID = 'c'.repeat(24);
const FILE_NAME = 'my-pc-20261102-153012.tar.gz2';

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function setup(
  options: { timeoutMs?: number; withArchivePvc?: boolean; notifyArchiveFailures?: number } = {},
) {
  const repo = new InMemoryContainerRepository();
  const client = new InMemoryK8sClient();
  let archiveCallbackFailures = options.notifyArchiveFailures ?? 0;
  const storageManager = new K8sStorageManager(client, {
    namespace: 'zag-cloud',
    storagePvcPrefix: 'zag-storage-',
    archivePvcPrefix: 'zag-archive-',
    storageClass: 'ceph-rbd',
    archiveStorageClass: 'cephfs',
    archivePvcSize: '100Gi',
    archiveAccessMode: 'ReadWriteOnce',
  });
  const archiveCalls: Array<{ storageId: string; payload: ArchiveCallbackPayload }> = [];
  const usageCalls: Array<{ storageId: string; payload: UsageCallbackPayload }> = [];
  const restoreCalls: Array<{ storageId: string; payload: RestoreCallbackPayload }> = [];
  const testLog = createTestLogger();
  const operationRepo = new InMemoryStorageOperationRepository();
  const service = new StorageService({
    repo,
    k8sClient: client,
    storageManager,
    operationRepo,
    logger: testLog.logger,
    config: {
      namespace: 'zag-cloud',
      archiverImage: 'archiver:test',
      archiveTimeoutMs: options.timeoutMs ?? 1000,
      pollIntervalMs: 2,
    },
    agentApiClient: {
      notifyStorageArchive: async (storageId, payload) => {
        if (archiveCallbackFailures > 0) {
          archiveCallbackFailures -= 1;
          throw new Error('agent-api unavailable');
        }
        archiveCalls.push({ storageId, payload: payload as ArchiveCallbackPayload });
      },
      notifyStorageUsage: async (storageId, payload) => {
        usageCalls.push({ storageId, payload: payload as UsageCallbackPayload });
      },
      notifyStorageRestore: async (storageId, payload) => {
        restoreCalls.push({ storageId, payload: payload as RestoreCallbackPayload });
      },
    },
  });
  return {
    repo,
    client,
    storageManager,
    service,
    archiveCalls,
    usageCalls,
    restoreCalls,
    operationRepo,
    testLog,
  };
}

async function seedStorage(
  client: InMemoryK8sClient,
  storageManager: K8sStorageManager,
  storageId = STORAGE_ID,
  workspaceId = WORKSPACE_ID,
): Promise<void> {
  await storageManager.ensureStoragePvc({
    storageId,
    tenantId: TENANT_ID,
    workspaceId,
    sizeGi: 10,
  });
  void client;
}

async function createTerminalContainer(
  repo: InMemoryContainerRepository,
  overrides: Record<string, unknown> = {},
) {
  return repo.create({
    name: `zag-worker-${Math.random().toString(36).slice(2, 8)}`,
    namespace: 'zag-cloud',
    purpose: 'harness',
    image: 'worker:test',
    status: 'exited',
    connectedAt: new Date('2026-11-02T10:00:00Z'),
    exitedAt: new Date('2026-11-02T11:00:00Z'),
    hostId: 'host-1',
    hostName: 'my-pc',
    tenantId: TENANT_ID,
    storageId: STORAGE_ID,
    storagePvcName: `zag-storage-${STORAGE_ID}`,
    storageSizeGi: 10,
    storageWorkspaceId: WORKSPACE_ID,
    storageStorageClass: 'ceph-rbd',
    ...overrides,
  });
}

/** 让新建的归档/用量 Job 立即成功并写入标记行（测试确定性）。 */
function autoComplete(
  client: InMemoryK8sClient,
  opts: { app: string; log: string | null; phase?: 'succeeded' | 'failed' },
): void {
  client.onJobCreated = (manifest) => {
    if (manifest.metadata.labels.app !== opts.app) return;
    if (opts.log !== null) client.setPodLog(manifest.metadata.name, opts.log);
    client.setPhase(manifest.metadata.name, opts.phase ?? 'succeeded');
  };
}

describe('parseUsageBytes / buildArchiveScript', () => {
  it('解析 ZAG_ARCHIVE_RESULT 标记行', () => {
    expect(parseUsageBytes('hello\nZAG_ARCHIVE_RESULT={"usageBytes":5368709120}\n')).toBe(
      5368709120,
    );
    expect(parseUsageBytes('ZAG_ARCHIVE_RESULT={"usageBytes":0}')).toBe(0);
    expect(parseUsageBytes('no marker here')).toBeNull();
    expect(parseUsageBytes('ZAG_ARCHIVE_RESULT={"usageBytes":"x"}')).toBeNull();
    expect(parseUsageBytes('ZAG_ARCHIVE_RESULT={broken')).toBeNull();
  });

  it('T-CC-AR1: 脚本顺序 rm .tmp → 压缩 → du → 删旧 → mv → 标记行', () => {
    const script = buildArchiveScript();
    const order = [
      'rm -f "$dir"/*.tmp',
      'tar -cf - -C "$SOURCE_DIR" . | pbzip2 -9 > "$tmp"',
      'usage=$(du -sb "$SOURCE_DIR" | cut -f1)',
      'rm -f "$dir"/*.tar.gz2',
      'mv "$tmp" "$final"',
      'echo "ZAG_ARCHIVE_RESULT={\\"usageBytes\\":$usage}"',
    ].map((needle) => script.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('StorageService 归档', () => {
  it('T-CC-AR1/AR2: 归档 Job manifest 与成功链路（解析用量 → 删源 PVC → 回调）', async () => {
    const { repo, client, storageManager, service, archiveCalls } = setup();
    await seedStorage(client, storageManager);
    const container = await createTerminalContainer(repo);
    autoComplete(client, {
      app: 'zag-archive',
      log: 'ZAG_ARCHIVE_RESULT={"usageBytes":2048}',
    });

    const result = await service.startArchive(container.id, {
      archiveId: 'archive-1',
      fileName: FILE_NAME,
    });
    expect(result).toEqual({ accepted: true, archiveId: 'archive-1' });
    await service.drainArchiveTasks();

    const manifest = client.createdManifests.find((m) => m.metadata.labels.app === 'zag-archive');
    expect(manifest).toBeDefined();
    const podSpec = manifest!.spec.template.spec;
    expect(podSpec.restartPolicy).toBe('Never');
    expect(podSpec.volumes).toEqual([
      {
        name: 'source',
        persistentVolumeClaim: { claimName: `zag-storage-${STORAGE_ID}`, readOnly: true },
      },
      {
        name: 'archive',
        persistentVolumeClaim: { claimName: `zag-archive-${WORKSPACE_ID}` },
      },
    ]);
    const archiver = podSpec.containers[0]!;
    expect(archiver.image).toBe('archiver:test');
    expect(archiver.command).toEqual(['/usr/local/bin/archiver-entrypoint.sh']);
    expect(archiver.env).toContainEqual({ name: 'MODE', value: 'archive' });
    // Pod 模板必须携带同一组标签（K8s 不会复制 Job metadata.labels 给 Pod）。
    expect(manifest!.spec.template.metadata?.labels).toMatchObject({
      app: 'zag-archive',
      'zag.cloud/container-id': container.id,
      'zag.cloud/archive-id': 'archive-1',
    });
    expect(archiver.volumeMounts).toEqual([
      { name: 'source', mountPath: '/source', readOnly: true },
      { name: 'archive', mountPath: '/archive' },
    ]);
    expect(archiver.env).toContainEqual({ name: 'ARCHIVE_FILE', value: FILE_NAME });

    const stored = await repo.findById(container.id);
    expect(stored?.storageArchiveStatus).toBe('succeeded');
    expect(stored?.storageArchiveUsageBytes).toBe(2048);
    expect(stored?.storageArchiveId).toBe('archive-1');
    expect(await service.isSourcePvcReleased(STORAGE_ID)).toBe(true);
    expect(
      client.deletedPvcNames.filter((name) => name === `zag-storage-${STORAGE_ID}`),
    ).toHaveLength(1);

    const success = archiveCalls.at(-1)!;
    expect(success.storageId).toBe(STORAGE_ID);
    expect(success.payload).toMatchObject({
      archiveId: 'archive-1',
      status: 'SUCCEEDED',
      usageBytes: 2048,
      sourcePvcReleased: true,
      path: `/archive/${WORKSPACE_ID}/${STORAGE_ID}/${FILE_NAME}`,
    });
    expect(archiveCalls.map((call) => call.payload.status)).toEqual(['RUNNING', 'SUCCEEDED']);
  });

  it('T-CC-AR2: 源 PVC 删除失败重试 3 次后仍回调 SUCCEEDED（sourcePvcReleased=false）', async () => {
    const { repo, client, storageManager, service, archiveCalls } = setup();
    await seedStorage(client, storageManager);
    const container = await createTerminalContainer(repo);
    autoComplete(client, {
      app: 'zag-archive',
      log: 'ZAG_ARCHIVE_RESULT={"usageBytes":512}',
    });
    client.failDeletePvcTimes = 3;

    await service.startArchive(container.id, { archiveId: 'archive-1', fileName: FILE_NAME });
    await service.drainArchiveTasks();

    const stored = await repo.findById(container.id);
    expect(stored?.storageArchiveStatus).toBe('succeeded');
    const success = archiveCalls.at(-1)!;
    expect(success.payload.status).toBe('SUCCEEDED');
    expect(success.payload.sourcePvcReleased).toBe(false);
  });

  it('T-CC-AR2b: 源 PVC 删除失败 + 回调未送达 → 巡检重投上报 sourcePvcReleased=false', async () => {
    const { repo, client, storageManager, service, archiveCalls } = setup({
      notifyArchiveFailures: 2,
    });
    await seedStorage(client, storageManager);
    const container = await createTerminalContainer(repo);
    autoComplete(client, {
      app: 'zag-archive',
      log: 'ZAG_ARCHIVE_RESULT={"usageBytes":512}',
    });
    client.failDeletePvcTimes = 3;

    await service.startArchive(container.id, { archiveId: 'archive-1', fileName: FILE_NAME });
    await service.drainArchiveTasks();

    const stored = await repo.findById(container.id);
    expect(stored?.storageArchiveStatus).toBe('succeeded');
    expect(archiveCalls).toHaveLength(0);
    expect(await service.isSourcePvcReleased(STORAGE_ID)).toBe(false); // 删除 3 次失败后仍存在

    await service.reconcileArchives();
    const reposted = archiveCalls.at(-1)!;
    expect(reposted.payload).toMatchObject({
      archiveId: 'archive-1',
      status: 'SUCCEEDED',
      sourcePvcReleased: false,
    });
  });

  it('T-CC-AR3: Job 失败 → failed + 回调；源 PVC 与旧归档保留', async () => {
    const { repo, client, storageManager, service, archiveCalls } = setup();
    await seedStorage(client, storageManager);
    await storageManager.ensureArchivePvc(WORKSPACE_ID);
    const container = await createTerminalContainer(repo);
    autoComplete(client, { app: 'zag-archive', log: null, phase: 'failed' });

    await service.startArchive(container.id, { archiveId: 'archive-1', fileName: FILE_NAME });
    await service.drainArchiveTasks();

    const stored = await repo.findById(container.id);
    expect(stored?.storageArchiveStatus).toBe('failed');
    expect(stored?.storageArchiveFailure).toBeTruthy();
    expect(await service.isSourcePvcReleased(STORAGE_ID)).toBe(false);
    expect(archiveCalls.at(-1)!.payload.status).toBe('FAILED');
  });

  it('T-CC-AR3: Job succeeded 但标记行缺失 → failed（不删源 PVC）', async () => {
    const { repo, client, storageManager, service } = setup();
    await seedStorage(client, storageManager);
    const container = await createTerminalContainer(repo);
    autoComplete(client, { app: 'zag-archive', log: 'no marker' });

    await service.startArchive(container.id, { archiveId: 'archive-1', fileName: FILE_NAME });
    await service.drainArchiveTasks();

    const stored = await repo.findById(container.id);
    expect(stored?.storageArchiveStatus).toBe('failed');
    expect(stored?.storageArchiveFailure).toContain('用量标记行缺失');
    expect(await service.isSourcePvcReleased(STORAGE_ID)).toBe(false);
  });

  it('T-CC-AR3: 归档超时 → failed', async () => {
    const { repo, client, storageManager, service } = setup({ timeoutMs: 30 });
    await seedStorage(client, storageManager);
    const container = await createTerminalContainer(repo);

    await service.startArchive(container.id, { archiveId: 'archive-1', fileName: FILE_NAME });
    await service.drainArchiveTasks();

    const stored = await repo.findById(container.id);
    expect(stored?.storageArchiveStatus).toBe('failed');
    expect(stored?.storageArchiveFailure).toBe('归档超时');
  });

  it('T-CC-AR4: 重复触发不产生第二个 Job（409 语义）', async () => {
    const { repo, client, storageManager, service } = setup();
    await seedStorage(client, storageManager);
    const container = await createTerminalContainer(repo);
    autoComplete(client, { app: 'zag-archive', log: 'ZAG_ARCHIVE_RESULT={"usageBytes":1}' });

    await service.startArchive(container.id, { archiveId: 'archive-1', fileName: FILE_NAME });
    await expect(
      service.startArchive(container.id, { archiveId: 'archive-2', fileName: FILE_NAME }),
    ).rejects.toBeInstanceOf(StorageArchiveRunningError);
    await service.drainArchiveTasks();

    const archiveJobs = client.createdManifests.filter(
      (m) => m.metadata.labels.app === 'zag-archive',
    );
    expect(archiveJobs).toHaveLength(1);
    expect((await repo.findById(container.id))?.storageArchiveId).toBe('archive-1');
  });

  it('T-CC-AR1: 仅 exited/failed 允许归档（destroying 仍活跃 → 拒绝）', async () => {
    const { repo, client, storageManager, service } = setup();
    await seedStorage(client, storageManager);
    const destroying = await createTerminalContainer(repo, { status: 'destroying' });
    await expect(
      service.startArchive(destroying.id, { archiveId: 'a-destroying', fileName: FILE_NAME }),
    ).rejects.toBeInstanceOf(ContainerActiveError);

    const failed = await createTerminalContainer(repo, { status: 'failed' });
    autoComplete(client, { app: 'zag-archive', log: 'ZAG_ARCHIVE_RESULT={"usageBytes":1}' });
    await expect(
      service.startArchive(failed.id, { archiveId: 'a-failed', fileName: FILE_NAME }),
    ).resolves.toMatchObject({ accepted: true });
    await service.drainArchiveTasks();
  });

  it('T-CC-AR4: maybeStartArchive 幂等（succeeded 后不再触发）', async () => {
    const { repo, client, storageManager, service } = setup();
    await seedStorage(client, storageManager);
    const container = await createTerminalContainer(repo, {
      connectedAt: new Date(),
    });
    autoComplete(client, { app: 'zag-archive', log: 'ZAG_ARCHIVE_RESULT={"usageBytes":1}' });

    const first = await service.maybeStartArchive(container.id);
    expect(first.started).toBe(true);
    await service.drainArchiveTasks();
    expect((await repo.findById(container.id))?.storageArchiveStatus).toBe('succeeded');

    const second = await service.maybeStartArchive(container.id);
    expect(second.started).toBe(false);
  });

  it('T-CC-AR5: 同工作区并发归档串行；不同工作区并行', async () => {
    const { repo, client, storageManager, service } = setup({ timeoutMs: 5000 });
    await seedStorage(client, storageManager, STORAGE_ID, WORKSPACE_ID);
    const otherStorage = 'd'.repeat(24);
    const otherWorkspace = 'e'.repeat(24);
    await seedStorage(client, storageManager, otherStorage, WORKSPACE_ID);
    await seedStorage(client, storageManager, 'f'.repeat(24), otherWorkspace);

    const first = await createTerminalContainer(repo);
    const second = await createTerminalContainer(repo, {
      storageId: otherStorage,
      storagePvcName: `zag-storage-${otherStorage}`,
    });
    const jobs: string[] = [];
    client.onJobCreated = (manifest) => {
      if (manifest.metadata.labels.app === 'zag-archive') jobs.push(manifest.metadata.name);
    };

    await service.startArchive(first.id, { archiveId: 'a1', fileName: FILE_NAME });
    await service.startArchive(second.id, { archiveId: 'a2', fileName: FILE_NAME });
    await new Promise((resolve) => setTimeout(resolve, 40));
    // 同工作区：第二个归档必须等第一个完成（KeyedMutex）。
    expect(jobs).toHaveLength(1);

    client.setPodLog(jobs[0]!, 'ZAG_ARCHIVE_RESULT={"usageBytes":7}');
    client.setPhase(jobs[0]!, 'succeeded');
    await waitFor(() => jobs.length === 2);
    client.setPodLog(jobs[1]!, 'ZAG_ARCHIVE_RESULT={"usageBytes":8}');
    client.setPhase(jobs[1]!, 'succeeded');
    await service.drainArchiveTasks();

    // 不同工作区：可并行创建（两个 Job 在完成前同时存在）。
    const third = await createTerminalContainer(repo, {
      storageId: 'f'.repeat(24),
      storagePvcName: `zag-storage-${'f'.repeat(24)}`,
      storageWorkspaceId: otherWorkspace,
    });
    const parallelJobs: string[] = [];
    client.onJobCreated = (manifest) => {
      if (manifest.metadata.labels.app === 'zag-archive') parallelJobs.push(manifest.metadata.name);
    };
    await service.startArchive(first.id, { archiveId: 'b1', fileName: FILE_NAME });
    await service.startArchive(third.id, { archiveId: 'b2', fileName: FILE_NAME });
    await waitFor(() => parallelJobs.length === 2);
    for (const job of parallelJobs) {
      client.setPodLog(job, 'ZAG_ARCHIVE_RESULT={"usageBytes":9}');
      client.setPhase(job, 'succeeded');
    }
    await service.drainArchiveTasks();
  });
});

describe('StorageService 用量刷新（T-CC-U1）', () => {
  it('du Job 固定 nodeName、只读挂载并回调 /usage', async () => {
    const { repo, client, storageManager, service, usageCalls } = setup();
    await seedStorage(client, storageManager);
    const container = await repo.create({
      name: 'zag-worker-usage',
      namespace: 'zag-cloud',
      purpose: 'harness',
      image: 'worker:test',
      status: 'online',
      connectedAt: new Date(),
      hostId: 'host-1',
      storageId: STORAGE_ID,
      storagePvcName: `zag-storage-${STORAGE_ID}`,
      storageSizeGi: 10,
      storageWorkspaceId: WORKSPACE_ID,
    });
    await client.createJob({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: container.name,
        namespace: 'zag-cloud',
        labels: { app: 'zag-worker', 'zag.cloud/container-id': container.id },
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 600,
        template: {
          metadata: { labels: { app: 'zag-worker', 'zag.cloud/container-id': container.id } },
          spec: {
            restartPolicy: 'Never',
            containers: [{ name: 'worker', image: 'w', env: [], resources: { limits: { cpu: '1', memory: '1Gi' } } }],
          },
        },
      },
    });
    client.setPodNode(container.name, 'node-1');
    autoComplete(client, {
      app: 'zag-usage',
      log: 'ZAG_ARCHIVE_RESULT={"usageBytes":12345}',
    });

    const result = await service.refreshUsage(STORAGE_ID, container.id);
    expect(result).toEqual({ accepted: true });
    await service.drainArchiveTasks();

    const job = client.createdManifests.find((m) => m.metadata.labels.app === 'zag-usage')!;
    expect(job.spec.template.spec.nodeName).toBe('node-1');
    expect(job.spec.template.metadata?.labels).toMatchObject({
      app: 'zag-usage',
      'zag.cloud/container-id': container.id,
      'zag.cloud/storage-id': STORAGE_ID,
    });
    expect(job.spec.template.spec.volumes?.[0]?.persistentVolumeClaim?.readOnly).toBe(true);
    expect(usageCalls).toHaveLength(1);
    expect(usageCalls[0]!.payload.usageBytes).toBe(12345);
  });
});

describe('StorageService 清理（T-CC-D1）', () => {
  it('删除源 PVC（404 幂等）+ 清理 Job 删除归档目录', async () => {
    const { client, storageManager, service } = setup();
    await seedStorage(client, storageManager);
    await storageManager.ensureArchivePvc(WORKSPACE_ID);

    const result = await service.cleanup({
      storageId: STORAGE_ID,
      workspaceId: WORKSPACE_ID,
      deleteArchive: true,
    });
    expect(result).toEqual({ accepted: true });
    expect(await service.isSourcePvcReleased(STORAGE_ID)).toBe(true);

    const cleanupJob = client.createdManifests.find(
      (m) => m.metadata.labels.app === 'zag-cleanup',
    )!;
    expect(cleanupJob.metadata.labels['zag.cloud/storage-id']).toBe(STORAGE_ID);
    const spec = cleanupJob.spec.template.spec;
    expect(spec.volumes?.[0]?.persistentVolumeClaim?.claimName).toBe(
      `zag-archive-${WORKSPACE_ID}`,
    );
    expect(spec.containers[0]!.command).toEqual(['/usr/local/bin/archiver-entrypoint.sh']);
    expect(spec.containers[0]!.env).toContainEqual({ name: 'MODE', value: 'cleanup' });
    expect(cleanupJob.spec.template.metadata?.labels).toMatchObject({
      app: 'zag-cleanup',
      'zag.cloud/storage-id': STORAGE_ID,
    });

    // 重复清理：源 PVC 已不存在按成功处理（幂等）。
    await expect(
      service.cleanup({ storageId: STORAGE_ID, workspaceId: WORKSPACE_ID, deleteArchive: false }),
    ).resolves.toEqual({ accepted: true });
  });

  it('归档进行中 → StorageArchiveRunningError（409）', async () => {
    const { repo, storageManager, service } = setup();
    await repo.create({
      name: 'zag-worker-running',
      namespace: 'zag-cloud',
      purpose: 'harness',
      image: 'worker:test',
      status: 'exited',
      storageId: STORAGE_ID,
      storagePvcName: `zag-storage-${STORAGE_ID}`,
      storageWorkspaceId: WORKSPACE_ID,
      storageArchiveStatus: 'running',
      storageArchiveId: 'archive-1',
    });

    await expect(
      service.cleanup({ storageId: STORAGE_ID, workspaceId: WORKSPACE_ID, deleteArchive: true }),
    ).rejects.toBeInstanceOf(StorageArchiveRunningError);
    void storageManager;
  });
});

describe('StorageService 恢复准备', () => {
  it('T-CC-RS1: 先删残留同名 PVC 再按原容量/StorageClass 重建', async () => {
    const { client, storageManager, service } = setup();
    await storageManager.ensureStoragePvc({
      storageId: STORAGE_ID,
      workspaceId: WORKSPACE_ID,
      sizeGi: 10,
      storageClass: 'ceph-rbd',
    });

    const result = await service.prepareForStart(
      {
        id: STORAGE_ID,
        pvcName: `zag-storage-${STORAGE_ID}`,
        sizeGi: 10,
        workspaceId: WORKSPACE_ID,
        storageClass: 'ceph-rbd',
        restore: { archivePath: `/archive/${WORKSPACE_ID}/${STORAGE_ID}/${FILE_NAME}` },
      },
      TENANT_ID,
    );

    expect(result.created).toBe(true);
    expect(client.deletedPvcNames).toContain(`zag-storage-${STORAGE_ID}`);
    expect(client.createdPvcManifests.at(-1)?.spec.storageClassName).toBe('ceph-rbd');
    expect(client.createdPvcManifests.at(-1)?.spec.resources.requests.storage).toBe('10Gi');
  });
});

describe('StorageService 巡检', () => {
  it('T-CC-AR4: 重启后 pending/running 补跑；succeeded 未回调重投（各一次）', async () => {
    const { repo, client, storageManager, service, archiveCalls } = setup();
    await seedStorage(client, storageManager);
    autoComplete(client, { app: 'zag-archive', log: 'ZAG_ARCHIVE_RESULT={"usageBytes":3}' });

    const pending = await createTerminalContainer(repo, {
      storageArchiveStatus: 'pending',
      storageArchiveId: 'archive-pending',
      storageArchiveFileName: FILE_NAME,
      storageArchiveStartedAt: new Date(),
    });

    const first = await service.reconcileArchives(Date.now());
    expect(first.retried).toBeGreaterThanOrEqual(1);
    await service.drainArchiveTasks();
    expect((await repo.findById(pending.id))?.storageArchiveStatus).toBe('succeeded');

    // 已完成未回调：新实例（模拟重启）首次巡检重投一次，二次不重复。
    const succeeded = await createTerminalContainer(repo, {
      storageArchiveStatus: 'succeeded',
      storageArchiveId: 'archive-done',
      storageArchiveFileName: FILE_NAME,
      storageArchiveUsageBytes: 42,
      storageArchiveStartedAt: new Date(),
      storageArchiveFinishedAt: new Date(),
    });
    const restarted = new StorageService({
      repo,
      k8sClient: client,
      storageManager,
      logger: createTestLogger().logger,
      config: {
        namespace: 'zag-cloud',
        archiverImage: 'archiver:test',
        archiveTimeoutMs: 1000,
        pollIntervalMs: 2,
      },
      agentApiClient: {
        notifyStorageArchive: async (storageId, payload) => {
          archiveCalls.push({ storageId, payload: payload as ArchiveCallbackPayload });
        },
        notifyStorageUsage: async () => undefined,
      },
    });
    const before = archiveCalls.length;
    await restarted.reconcileArchives(Date.now());
    const doneCalls = archiveCalls
      .slice(before)
      .filter((call) => call.payload.archiveId === 'archive-done');
    expect(doneCalls).toHaveLength(1);
    expect(doneCalls[0]!.payload).toMatchObject({
      archiveId: 'archive-done',
      status: 'SUCCEEDED',
      usageBytes: 42,
    });
    await restarted.reconcileArchives(Date.now());
    expect(
      archiveCalls.slice(before).filter((call) => call.payload.archiveId === 'archive-done'),
    ).toHaveLength(1);
    expect((await repo.findById(succeeded.id))?.storageArchiveStatus).toBe('succeeded');
  });

  it('T-CC-AR3: pending/running 超过 ARCHIVE_TIMEOUT_MS → failed', async () => {
    const { repo, service, archiveCalls } = setup({ timeoutMs: 100 });
    const container = await createTerminalContainer(repo, {
      storageArchiveStatus: 'running',
      storageArchiveId: 'archive-slow',
      storageArchiveFileName: FILE_NAME,
      storageArchiveStartedAt: new Date(Date.now() - 10_000),
    });

    const result = await service.reconcileArchives(Date.now());
    expect(result.failed).toBe(1);
    const stored = await repo.findById(container.id);
    expect(stored?.storageArchiveStatus).toBe('failed');
    expect(stored?.storageArchiveFailure).toBe('归档超时');
    expect(archiveCalls.at(-1)!.payload.status).toBe('FAILED');
  });

  it('终态容器未触发归档（历史/崩溃）→ 自动补触发', async () => {
    const { repo, client, storageManager, service } = setup();
    await seedStorage(client, storageManager);
    autoComplete(client, { app: 'zag-archive', log: 'ZAG_ARCHIVE_RESULT={"usageBytes":5}' });
    const container = await createTerminalContainer(repo, { storageArchiveStatus: null });

    const result = await service.reconcileArchives(Date.now());
    expect(result.retried).toBeGreaterThanOrEqual(1);
    await service.drainArchiveTasks();
    expect((await repo.findById(container.id))?.storageArchiveStatus).toBe('succeeded');
  });

  it('T-SKIP4b: 跳过标记的终态容器不会被巡检补归档', async () => {
    const { repo, client, storageManager, service } = setup();
    await seedStorage(client, storageManager);
    autoComplete(client, { app: 'zag-archive', log: 'ZAG_ARCHIVE_RESULT={"usageBytes":5}' });
    const container = await createTerminalContainer(repo, {
      storageArchiveStatus: null,
      storageArchiveSkipped: true,
    });

    const result = await service.reconcileArchives(Date.now());
    await service.drainArchiveTasks();
    expect(result.retried).toBe(0);
    expect((await repo.findById(container.id))?.storageArchiveStatus).toBeNull();
  });
});

describe('存储级归档/复原（T-AR4 / T-RS4 / T-OP）', () => {
  const OPERATION_ID = 'd'.repeat(24);

  it('T-AR4: 存储级归档成功 → 台账 succeeded、回调 SUCCEEDED、删源 PVC', async () => {
    const { client, storageManager, service, archiveCalls, operationRepo } = setup();
    await seedStorage(client, storageManager);
    client.onJobCreated = (manifest) => {
      if (manifest.metadata.labels.app !== 'zag-archive') return;
      client.setPodLog(manifest.metadata.name, 'ZAG_ARCHIVE_RESULT={"usageBytes":123}');
      client.setPhase(manifest.metadata.name, 'succeeded');
    };

    const accepted = await service.startStorageArchive(STORAGE_ID, {
      operationId: OPERATION_ID,
      archiveId: 'archive-op-1',
      fileName: FILE_NAME,
      workspaceId: WORKSPACE_ID,
      tenantId: TENANT_ID,
    });
    expect(accepted).toEqual({ accepted: true, operationId: OPERATION_ID });
    await service.drainArchiveTasks();

    const operation = await operationRepo.findById(OPERATION_ID);
    expect(operation?.status).toBe('succeeded');
    expect(operation?.usageBytes).toBe(123);
    expect(archiveCalls.map((call) => call.payload.status)).toEqual([
      'RUNNING',
      'SUCCEEDED',
    ]);
    expect(archiveCalls[1]!.payload.operationId).toBe(OPERATION_ID);
    expect(await storageManager.getStoragePvc(STORAGE_ID)).toBeNull();
  });

  it('T-AR4: 同存储进行中 → 409 OPERATION_RUNNING；同 operationId 重投幂等', async () => {
    const { client, storageManager, service, operationRepo } = setup();
    await seedStorage(client, storageManager);
    // 保持 pending（不自动完成），模拟进行中。
    await operationRepo.create({
      operationId: OPERATION_ID,
      storageId: STORAGE_ID,
      workspaceId: WORKSPACE_ID,
      type: 'archive',
    });

    await expect(
      service.startStorageArchive(STORAGE_ID, {
        operationId: 'e'.repeat(24),
        archiveId: 'archive-op-2',
        fileName: FILE_NAME,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toBeInstanceOf(OperationRunningError);

    await expect(
      service.startStorageArchive(STORAGE_ID, {
        operationId: OPERATION_ID,
        archiveId: 'archive-op-1',
        fileName: FILE_NAME,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toEqual({ accepted: true, operationId: OPERATION_ID });
  });

  it('T-RS4: 存储级复原 → 删/重建目标 PVC、restore Job（archive RO/target RW）、回调 SUCCEEDED', async () => {
    const { client, storageManager, service, restoreCalls, operationRepo } = setup();
    await seedStorage(client, storageManager);
    await storageManager.ensureArchivePvc(WORKSPACE_ID, TENANT_ID);
    client.onJobCreated = (manifest) => {
      if (manifest.metadata.labels.app !== 'zag-restore') return;
      client.setPodLog(manifest.metadata.name, 'ZAG_RESTORE_DONE');
      client.setPhase(manifest.metadata.name, 'succeeded');
    };

    const accepted = await service.startStorageRestore(STORAGE_ID, {
      operationId: OPERATION_ID,
      workspaceId: WORKSPACE_ID,
      tenantId: TENANT_ID,
      archivePath: `/archive/${WORKSPACE_ID}/${STORAGE_ID}/${FILE_NAME}`,
      sizeGi: 10,
      storageClass: 'ceph-rbd',
    });
    expect(accepted).toEqual({ accepted: true, operationId: OPERATION_ID });
    await service.drainArchiveTasks();

    const operation = await operationRepo.findById(OPERATION_ID);
    expect(operation?.status).toBe('succeeded');
    expect(restoreCalls.map((call) => call.payload.status)).toEqual([
      'RUNNING',
      'SUCCEEDED',
    ]);
    // 目标 PVC 已按 sizeGi/storageClass 重建。
    expect(await storageManager.getStoragePvc(STORAGE_ID)).not.toBeNull();

    const job = client.createdManifests.find((m) => m.metadata.labels.app === 'zag-restore');
    expect(job?.spec.template.spec.containers[0]!.env).toEqual(
      expect.arrayContaining([
        { name: 'MODE', value: 'restore' },
        {
          name: 'RESTORE_FILE',
          value: `/archive/${WORKSPACE_ID}/${STORAGE_ID}/${FILE_NAME}`,
        },
      ]),
    );
    expect(job?.spec.template.spec.containers[0]!.volumeMounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'archive', readOnly: true }),
        expect.objectContaining({ name: 'target' }),
      ]),
    );
  });

  it('T-OP1: 存储级操作失败 → 台账 failed + FAILED 回调；归档失败不删源 PVC', async () => {
    const { client, storageManager, service, archiveCalls, operationRepo } = setup();
    await seedStorage(client, storageManager);
    client.onJobCreated = (manifest) => {
      if (manifest.metadata.labels.app !== 'zag-archive') return;
      client.setPhase(manifest.metadata.name, 'failed', 'archiver failed');
    };

    await service.startStorageArchive(STORAGE_ID, {
      operationId: OPERATION_ID,
      archiveId: 'archive-op-3',
      fileName: FILE_NAME,
      workspaceId: WORKSPACE_ID,
    });
    await service.drainArchiveTasks();

    const operation = await operationRepo.findById(OPERATION_ID);
    expect(operation?.status).toBe('failed');
    expect(archiveCalls.at(-1)!.payload.status).toBe('FAILED');
    expect(await storageManager.getStoragePvc(STORAGE_ID)).not.toBeNull();
  });
});
