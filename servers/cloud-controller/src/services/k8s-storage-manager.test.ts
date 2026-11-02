import { describe, expect, it } from 'vitest';
import { InMemoryK8sClient, matchesLabelSelector } from './k8s-client.js';
import {
  K8sStorageManager,
  StoragePvcConflictError,
  buildArchiveFileName,
  sanitizeArchiveName,
} from './k8s-storage-manager.js';

function setup(overrides: Partial<ConstructorParameters<typeof K8sStorageManager>[1]> = {}) {
  const client = new InMemoryK8sClient();
  const manager = new K8sStorageManager(client, {
    namespace: 'zag-cloud',
    storagePvcPrefix: 'zag-storage-',
    archivePvcPrefix: 'zag-archive-',
    storageClass: 'ceph-rbd',
    archiveStorageClass: 'cephfs',
    archivePvcSize: '100Gi',
    archiveAccessMode: 'ReadWriteOnce',
    ...overrides,
  });
  return { client, manager };
}

const storage = {
  storageId: 'a'.repeat(24),
  tenantId: 't'.repeat(24),
  workspaceId: 'b'.repeat(24),
  sizeGi: 20,
};

describe('K8sStorageManager', () => {
  it('T-CC-P1: 源卷 manifest 名称/标签/容量/RWO/storageClass', async () => {
    const { client, manager } = setup();

    const manifest = manager.buildStoragePvcManifest(storage);

    expect(manifest.kind).toBe('PersistentVolumeClaim');
    expect(manifest.metadata.name).toBe(`zag-storage-${storage.storageId}`);
    expect(manifest.metadata.namespace).toBe('zag-cloud');
    expect(manifest.metadata.labels).toEqual({
      app: 'zag-storage',
      'zag.cloud/storage-id': storage.storageId,
      'zag.cloud/workspace-id': storage.workspaceId,
      'zag.cloud/tenant-id': storage.tenantId,
    });
    expect(manifest.spec.accessModes).toEqual(['ReadWriteOnce']);
    expect(manifest.spec.volumeMode).toBe('Filesystem');
    expect(manifest.spec.resources.requests.storage).toBe('20Gi');
    expect(manifest.spec.storageClassName).toBe('ceph-rbd');

    await manager.ensureStoragePvc(storage);
    expect(client.getPvc(`zag-storage-${storage.storageId}`)?.phase).toBe('Bound');
  });

  it('T-CC-P1: storageClass 为空时整段省略（不写空串）', () => {
    const { manager } = setup({
      storageClass: '',
      archiveStorageClass: '',
    });

    const storageManifest = manager.buildStoragePvcManifest({ ...storage, storageClass: null });
    expect('storageClassName' in storageManifest.spec).toBe(false);

    const archiveManifest = manager.buildArchivePvcManifest(storage.workspaceId!);
    expect('storageClassName' in archiveManifest.spec).toBe(false);
    expect(archiveManifest.spec.resources.requests.storage).toBe('100Gi');
    expect(archiveManifest.metadata.labels.app).toBe('zag-archive');
  });

  it('T-CC-P1: 归档卷容量/访问模式可配（100Gi 默认、RWX 覆盖）', () => {
    const { manager } = setup({ archivePvcSize: '200Gi', archiveAccessMode: 'ReadWriteMany' });
    const manifest = manager.buildArchivePvcManifest('c'.repeat(24), 't'.repeat(24));
    expect(manifest.metadata.name).toBe(`zag-archive-${'c'.repeat(24)}`);
    expect(manifest.spec.resources.requests.storage).toBe('200Gi');
    expect(manifest.spec.accessModes).toEqual(['ReadWriteMany']);
    expect(manifest.spec.storageClassName).toBe('cephfs');
  });

  it('T-CC-P2: ensure 幂等（已存在且规格一致 → created:false）', async () => {
    const { client, manager } = setup();

    const first = await manager.ensureStoragePvc(storage);
    const second = await manager.ensureStoragePvc(storage);

    expect(first.created).toBe(true);
    expect(second).toEqual({ pvcName: first.pvcName, created: false });
    expect(client.createdPvcManifests).toHaveLength(1);
  });

  it('T-CC-P2: 未指定 StorageClass 时，K8s 回填默认类名仍幂等（不误报冲突）', async () => {
    const { client, manager } = setup({ storageClass: '', archiveStorageClass: '' });
    const name = `zag-storage-${storage.storageId}`;
    // 模拟 K8s API 对省略 storageClassName 的 PVC 回填集群默认类名。
    await client.createPersistentVolumeClaim({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name,
        namespace: 'zag-cloud',
        labels: { app: 'zag-storage' },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        volumeMode: 'Filesystem',
        resources: { requests: { storage: '20Gi' } },
        storageClassName: 'cluster-default',
      },
    });

    await expect(manager.ensureStoragePvc({ ...storage, storageClass: null })).resolves.toEqual({
      pvcName: name,
      created: false,
    });

    const archiveName = `zag-archive-${storage.workspaceId}`;
    await client.createPersistentVolumeClaim({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: archiveName, namespace: 'zag-cloud', labels: { app: 'zag-archive' } },
      spec: {
        accessModes: ['ReadWriteOnce'],
        volumeMode: 'Filesystem',
        resources: { requests: { storage: '100Gi' } },
        storageClassName: 'cluster-default',
      },
    });
    await expect(manager.ensureArchivePvc(storage.workspaceId!, storage.tenantId)).resolves.toEqual({
      pvcName: archiveName,
      created: false,
    });
  });

  it('T-CC-P3: 已存在但容量或 StorageClass 不同 → StoragePvcConflictError', async () => {
    const { manager } = setup();
    await manager.ensureStoragePvc(storage);

    await expect(manager.ensureStoragePvc({ ...storage, sizeGi: 30 })).rejects.toBeInstanceOf(
      StoragePvcConflictError,
    );
    await expect(
      manager.ensureStoragePvc({ ...storage, storageClass: 'other-class' }),
    ).rejects.toBeInstanceOf(StoragePvcConflictError);
  });

  it('T-CC-P2: 删除 404 视为成功（幂等）', async () => {
    const { client, manager } = setup();
    await manager.ensureStoragePvc(storage);

    await manager.deleteStoragePvc(storage.storageId);
    expect(await manager.getStoragePvc(storage.storageId)).toBeNull();
    await expect(manager.deleteStoragePvc(storage.storageId)).resolves.toBeUndefined();
    expect(client.deletedPvcNames).toHaveLength(2);
  });

  it('T-CC-P1: 名称全部由服务端生成（前缀可配）', async () => {
    const { manager } = setup({ storagePvcPrefix: 'st-', archivePvcPrefix: 'ar-' });
    expect(manager.storagePvcName('x1')).toBe('st-x1');
    expect(manager.archivePvcName('w1')).toBe('ar-w1');
  });
});

describe('sanitizeArchiveName / buildArchiveFileName', () => {
  it('保留 ASCII 安全字符并折叠/去首尾 -', () => {
    expect(sanitizeArchiveName('my-pc_1.2')).toBe('my-pc_1.2');
    expect(sanitizeArchiveName('a  b---c')).toBe('a-b-c');
    expect(sanitizeArchiveName('-hello-')).toBe('hello');
    expect(sanitizeArchiveName('我的云电脑')).toBe('cloud-host');
    expect(sanitizeArchiveName('')).toBe('cloud-host');
    expect(sanitizeArchiveName(null)).toBe('cloud-host');
  });

  it('截断 64 字符且不含 ..', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeArchiveName(long)).toHaveLength(64);
    expect(sanitizeArchiveName('a..b')).toBe('a.b');
  });

  it('文件名 = <safe>-<YYYYMMDD-HHmmss>.tar.gz2', () => {
    const at = new Date('2026-11-02T15:30:12Z');
    expect(buildArchiveFileName('我的云电脑', at)).toBe('cloud-host-20261102-153012.tar.gz2');
  });
});

describe('matchesLabelSelector', () => {
  it('支持等值标签与多条件', () => {
    const labels = { app: 'zag-worker', 'zag.cloud/container-id': 'c1' };
    expect(matchesLabelSelector(labels, 'app=zag-worker')).toBe(true);
    expect(matchesLabelSelector(labels, 'app=zag-worker,zag.cloud/container-id=c1')).toBe(true);
    expect(matchesLabelSelector(labels, 'app=zag-archive')).toBe(false);
  });
});
