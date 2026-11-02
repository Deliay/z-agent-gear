import { describe, expect, it } from 'vitest';
import { ContainerService, type StartHarnessOptions } from './container-service.js';
import { InMemoryK8sClient } from './k8s-client.js';
import { K8sJobManager } from './k8s-job-manager.js';
import { K8sStorageManager } from './k8s-storage-manager.js';
import { StorageService, type ArchiveCallbackPayload } from './storage-service.js';
import { TokenService } from './token-service.js';
import { SecretStore, type HarnessSecrets } from './secret-store.js';
import { InMemoryContainerRepository } from '../repositories/container-repository.js';
import { createTestLogger } from '../observability/testing.js';

const STORAGE_ID = 'a'.repeat(24);
const WORKSPACE_ID = 'b'.repeat(24);
const TENANT_ID = 'c'.repeat(24);
const FILE_NAME = 'my-pc-20261102-153012.tar.gz2';

function harnessSecrets(): HarnessSecrets {
  return {
    hostEndpoint: 'wss://controller.example.com',
    hostKey: 'zag_k_1_host-secret',
    modelApiKey: 'zag_sk_model-secret',
    modelBaseUrl: 'http://admin-api:8002/v1',
    modelIds: '["model-a"]',
    defaultWorkspace: '/home/worker/workspace',
  };
}

function harnessOptions(overrides: Partial<StartHarnessOptions> = {}): StartHarnessOptions {
  return {
    hostId: 'host-1',
    hostName: 'my-pc',
    harnessTypes: ['opencode'],
    controllerKeyId: 'ck-1',
    containerApiKeyId: 'ak-1',
    userId: 'user-1',
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    expiresAt: new Date(Date.now() + 3600_000),
    secrets: harnessSecrets(),
    ...overrides,
  };
}

function storageInput(restore = false) {
  return {
    id: STORAGE_ID,
    pvcName: `zag-storage-${STORAGE_ID}`,
    sizeGi: 10,
    workspaceId: WORKSPACE_ID,
    storageClass: 'ceph-rbd',
    ...(restore
      ? { restore: { archivePath: `/archive/${WORKSPACE_ID}/${STORAGE_ID}/${FILE_NAME}` } }
      : {}),
  };
}

function setup() {
  const repo = new InMemoryContainerRepository();
  const client = new InMemoryK8sClient();
  const tokenService = new TokenService(repo);
  const jobManager = new K8sJobManager(client, {
    namespace: 'zag-cloud',
    image: 'zero-tools/zag-worker:latest',
    runtimeClassName: 'sysbox-runc',
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
  const archiveCalls: Array<{ storageId: string; payload: ArchiveCallbackPayload }> = [];
  const testLog = createTestLogger();
  const storageService = new StorageService({
    repo,
    k8sClient: client,
    storageManager,
    logger: testLog.logger,
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
  const service = new ContainerService(
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
    new SecretStore(),
    storageService,
  );
  return { repo, client, storageManager, storageService, service, archiveCalls, testLog };
}

function autoCompleteArchive(client: InMemoryK8sClient): void {
  client.onJobCreated = (manifest) => {
    if (manifest.metadata.labels.app !== 'zag-archive') return;
    client.setPodLog(manifest.metadata.name, 'ZAG_ARCHIVE_RESULT={"usageBytes":1024}');
    client.setPhase(manifest.metadata.name, 'succeeded');
  };
}

describe('ContainerService 云存储挂载（T-CC-J1/J2/RS1/RS2）', () => {
  it('T-CC-J1: 不带 storage 时 manifest 不出现任何存储字段（零回归）', async () => {
    const { client, service } = setup();

    const created = await service.start('harness', 'ck-1', [], [], harnessOptions());
    const manifest = client.getManifest(created.name)!;
    const podSpec = manifest.spec.template.spec;

    expect(podSpec.volumes).toBeUndefined();
    expect(podSpec.securityContext).toBeUndefined();
    expect(podSpec.initContainers).toBeUndefined();
    expect(podSpec.containers[0]!.volumeMounts).toBeUndefined();
    expect(Object.keys(podSpec).sort()).toEqual(
      [
        'automountServiceAccountToken',
        'containers',
        'hostUsers',
        'restartPolicy',
        'runtimeClassName',
      ].sort(),
    );
    expect(Object.keys(podSpec.containers[0]!).sort()).toEqual(
      ['env', 'image', 'name', 'resources'].sort(),
    );
    expect(client.createdPvcManifests).toHaveLength(0);
    expect(client.getEnv(created.name).ZAG_STORAGE_HOME).toBeUndefined();
  });

  it('T-CC-J2: 带 storage 时挂载 /home/worker + fsGroup + ZAG_STORAGE_HOME，且不注入 initContainers', async () => {
    const { repo, client, service } = setup();

    const created = await service.start(
      'harness',
      'ck-1',
      [],
      [],
      harnessOptions({ storage: storageInput() }),
    );

    const manifest = client.getManifest(created.name)!;
    const podSpec = manifest.spec.template.spec;
    expect(podSpec.securityContext).toEqual({
      fsGroup: 1000,
      fsGroupChangePolicy: 'OnRootMismatch',
    });
    expect(podSpec.volumes).toEqual([
      { name: 'storage', persistentVolumeClaim: { claimName: `zag-storage-${STORAGE_ID}` } },
    ]);
    expect(podSpec.containers[0]!.volumeMounts).toEqual([
      { name: 'storage', mountPath: '/home/worker' },
    ]);
    expect(podSpec.initContainers).toBeUndefined();
    expect(client.getEnv(created.name).ZAG_STORAGE_HOME).toBe('1');
    expect(client.getPvc(`zag-storage-${STORAGE_ID}`)).not.toBeNull();

    const stored = await repo.findById(created.id);
    expect(stored).toMatchObject({
      storageId: STORAGE_ID,
      storagePvcName: `zag-storage-${STORAGE_ID}`,
      storageSizeGi: 10,
      storageWorkspaceId: WORKSPACE_ID,
      storageStorageClass: 'ceph-rbd',
      storageRestorePath: null,
      storageArchiveStatus: null,
    });
  });

  it('T-CC-RS1: 恢复先删残留同名 PVC 再重建，并注入 storage-restore initContainer', async () => {
    const { client, storageManager, service } = setup();
    // 残留源 PVC（上次覆盖 sourcePvcReleased=false 或恢复失败留下）。
    await storageManager.ensureStoragePvc({
      storageId: STORAGE_ID,
      workspaceId: WORKSPACE_ID,
      sizeGi: 10,
      storageClass: 'ceph-rbd',
    });
    await storageManager.ensureArchivePvc(WORKSPACE_ID);

    const created = await service.start(
      'harness',
      'ck-1',
      [],
      [],
      harnessOptions({ storage: storageInput(true) }),
    );

    expect(client.deletedPvcNames).toContain(`zag-storage-${STORAGE_ID}`);
    const pvcManifest = client.createdPvcManifests.at(-1)!;
    expect(pvcManifest.metadata.name).toBe(`zag-storage-${STORAGE_ID}`);
    expect(pvcManifest.spec.resources.requests.storage).toBe('10Gi');
    expect(pvcManifest.spec.storageClassName).toBe('ceph-rbd');

    const podSpec = client.getManifest(created.name)!.spec.template.spec;
    expect(podSpec.volumes).toEqual([
      { name: 'storage', persistentVolumeClaim: { claimName: `zag-storage-${STORAGE_ID}` } },
      {
        name: 'archive',
        persistentVolumeClaim: { claimName: `zag-archive-${WORKSPACE_ID}`, readOnly: true },
      },
    ]);
    const initContainer = podSpec.initContainers![0]!;
    expect(initContainer.name).toBe('storage-restore');
    expect(initContainer.image).toBe('archiver:test');
    expect(initContainer.env).toContainEqual({
      name: 'RESTORE_FILE',
      value: `/archive/${WORKSPACE_ID}/${STORAGE_ID}/${FILE_NAME}`,
    });
    expect(initContainer.args?.[0]).toContain('tar -xjf "$RESTORE_FILE" -C /target');
    expect(initContainer.volumeMounts).toEqual([
      { name: 'storage', mountPath: '/target' },
      { name: 'archive', mountPath: '/archive', readOnly: true },
    ]);
  });

  it('T-CC-RS2: 恢复失败（未就绪）→ failed，且不误触发归档覆盖原归档', async () => {
    const { repo, client, service, storageService } = setup();
    client.onJobCreated = (manifest) => {
      if (manifest.metadata.labels.app === 'zag-worker') {
        client.setPhase(manifest.metadata.name, 'failed', 'storage-restore failed');
      }
    };

    const created = await service.start(
      'harness',
      'ck-1',
      [],
      [],
      harnessOptions({ storage: storageInput(true) }),
    );

    const failed = await service.markFailed(created.id, '容器异常退出');
    expect(failed?.status).toBe('failed');
    expect(failed?.storageRestorePath).toBe(
      `/archive/${WORKSPACE_ID}/${STORAGE_ID}/${FILE_NAME}`,
    );
    // 从未就绪（connectedAt=null）：不得归档（避免用空/半恢复卷覆盖原归档）。
    expect(failed?.storageArchiveStatus).toBeNull();
    await storageService.drainArchiveTasks();
    expect(
      client.createdManifests.filter((m) => m.metadata.labels.app === 'zag-archive'),
    ).toHaveLength(0);
    expect((await repo.findById(created.id))?.storageArchiveStatus).toBeNull();
  });

  it('destroy 后锁外触发归档（terminated 在线容器）', async () => {
    const { repo, client, service, storageService, archiveCalls } = setup();
    const created = await service.start(
      'harness',
      'ck-1',
      [],
      [],
      harnessOptions({ storage: storageInput() }),
    );
    await service.markOnline(created.id);
    autoCompleteArchive(client);

    const result = await service.destroy(created.id);
    expect(result.success).toBe(true);
    await storageService.drainArchiveTasks();

    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('exited');
    expect(stored?.storageArchiveStatus).toBe('succeeded');
    expect(archiveCalls.at(-1)!.payload.status).toBe('SUCCEEDED');
  });

  it('PVC 创建失败 → 容器 failed（不进入 connecting）', async () => {
    const { repo, client, service } = setup();
    client.failCreatePvcTimes = 1;

    await expect(
      service.start('harness', 'ck-1', [], [], harnessOptions({ storage: storageInput() })),
    ).rejects.toThrow(/存储 PVC 准备失败|createPersistentVolumeClaim failed/);

    const all = await repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('failed');
    expect(all[0]!.exitReason).toContain('存储 PVC 准备失败');
    expect(client.createdManifests).toHaveLength(0);
  });
});
