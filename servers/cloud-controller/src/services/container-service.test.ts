import { describe, it, expect } from 'vitest';
import {
  ContainerService,
  JobCreationError,
  UnsupportedPurposeError,
  type ContainerServiceConfig,
} from './container-service.js';
import { InMemoryK8sClient } from './k8s-client.js';
import { K8sJobManager } from './k8s-job-manager.js';
import { TokenService } from './token-service.js';
import { InMemoryContainerRepository } from '../repositories/container-repository.js';

function setup(overrides: Partial<ContainerServiceConfig> = {}) {
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
    ...overrides,
  });
  return { repo, client, tokenService, jobManager, service };
}

describe('ContainerService', () => {
  it('T-S1: start(idle) persists creating→connecting; token only via ZAG_CONTROLLER_KEY', async () => {
    const { repo, client, service } = setup();

    const created = await service.start('idle');

    expect(created.status).toBe('connecting');
    expect(repo.operations[0]).toBe('create:creating');
    expect(repo.operations).toContain('update:connecting');

    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('connecting');
    expect(stored?.name).toMatch(/^zag-worker-[a-z0-9]{6}$/);

    const env = client.getEnv(created.name);
    const token = env.ZAG_CONTROLLER_KEY!;
    expect(token).toBeTruthy();
    // 问题 11：握手 token 不再进入 URL，endpoint 只含 wss://.../worker
    expect(new URL(env.ZAG_SERVER_ENDPOINT!).search).toBe('');
  });

  it('T-S2: createJob failure marks the record failed and keeps it for forced cleanup', async () => {
    const { repo, client, service } = setup();
    client.failCreateTimes = 1;

    await expect(service.start('idle')).rejects.toBeInstanceOf(JobCreationError);

    const all = await repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('failed');
    expect(all[0]!.exitReason).toContain('Job 创建失败');

    // 失败记录可被强制销毁（幂等成功，不重复删除 Job）
    const result = await service.destroy(all[0]!.id);
    expect(result.success).toBe(true);
    expect(client.deleteCalls).toHaveLength(0);
    expect(await repo.findById(all[0]!.id)).not.toBeNull();
  });

  it('T-S3: destroy(online) notifies shutdown, deletes the job, invalidates the token', async () => {
    const { repo, client, tokenService, service } = setup();
    const created = await service.start('idle');
    await service.markOnline(created.id);

    const token = client.getEnv(created.name).ZAG_CONTROLLER_KEY!;
    expect(await tokenService.verify(token)).not.toBeNull();

    const shutdowns: string[] = [];
    service.onShutdown((id) => {
      shutdowns.push(id);
    });

    const result = await service.destroy(created.id);

    expect(shutdowns).toEqual([created.id]);
    expect(client.deleteCalls).toHaveLength(1);
    expect(client.deleteCalls[0]?.options?.propagationPolicy).toBe('Foreground');

    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('exited');
    expect(stored?.exitReason).toBe('强制销毁');
    expect(stored?.tokenHash).toBeNull();
    expect(await tokenService.verify(token)).toBeNull();
    expect(result.deletedJob).toBe(true);
  });

  it('T-S4: destroy(no response) still force-deletes the job and recycles resources', async () => {
    const { repo, client, service } = setup();
    const created = await service.start('idle');
    await service.markOnline(created.id);
    client.failDeleteTimes = 100; // every delete attempt fails

    const result = await service.destroy(created.id);

    expect(result.success).toBe(true);
    expect(result.deletedJob).toBe(false);
    const policies = client.deleteCalls.map((c) => c.options?.propagationPolicy);
    expect(policies.filter((p) => p === 'Foreground')).toHaveLength(3);
    expect(policies.filter((p) => p === 'Background')).toHaveLength(3);
    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('exited');
    // Job 删除失败时显式告警，便于运维清理残留 Job
    expect(stored?.exitReason).toContain('需人工清理');
  });

  it('T-S4b: destroy(online) with a real grace period completes and reports EXITED', async () => {
    const { repo, service } = setup({ shutdownGraceMs: 60 });
    const created = await service.start('idle');
    await service.markOnline(created.id);
    service.onShutdown(() => {});

    const startedAt = Date.now();
    const result = await service.destroy(created.id);
    const elapsed = Date.now() - startedAt;

    expect(result.success).toBe(true);
    expect(result.deletedJob).toBe(true);
    // 宽限期被真实等待（>0），admin-api 侧需用更长超时覆盖该窗口
    expect(elapsed).toBeGreaterThanOrEqual(55);
    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('exited');
    expect(stored?.exitReason).toBe('强制销毁');
  });

  it('T-S5: destroy(terminal) is idempotent and does not delete the job again', async () => {
    const { repo, client, service } = setup();
    const created = await service.start('idle');
    await service.markOnline(created.id);

    await service.destroy(created.id);
    expect(client.deleteCalls).toHaveLength(1);

    const second = await service.destroy(created.id);
    expect(second.success).toBe(true);
    expect(second.deletedJob).toBe(false);
    expect(client.deleteCalls).toHaveLength(1);
    expect((await repo.findById(created.id))?.status).toBe('exited');
  });

  it('T-S6: destroy(terminal failed with a残留 Job) still deletes the Job', async () => {
    const { repo, client, tokenService, service } = setup();
    const created = await service.start('idle'); // Job 已创建
    const token = client.getEnv(created.name).ZAG_CONTROLLER_KEY!;

    // 回连超时 → failed，但 Job 仍 active（ttl 只回收已完成 Job）
    await service.markFailed(created.id, '回连超时');
    expect((await repo.findById(created.id))?.status).toBe('failed');
    expect(await client.getJob(created.name)).not.toBeNull();

    const result = await service.destroy(created.id);

    expect(result.success).toBe(true);
    expect(result.deletedJob).toBe(true);
    expect(client.deleteCalls).toHaveLength(1);
    expect(await client.getJob(created.name)).toBeNull();
    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('failed'); // 保留终态记录
    expect(stored?.tokenHash).toBeNull();
    expect(await tokenService.verify(token)).toBeNull();
  });

  it('T-S7: markFailed clears tokenHash (defence in depth)', async () => {
    const { repo, client, tokenService, service } = setup();
    const created = await service.start('idle');
    const token = client.getEnv(created.name).ZAG_CONTROLLER_KEY!;
    expect(await tokenService.verify(token)).not.toBeNull();

    await service.markFailed(created.id, '回连超时');

    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.tokenHash).toBeNull();
    expect(await tokenService.verify(token)).toBeNull();
  });

  it('T-S8: stale markOnline after a terminal transition is rejected (CAS)', async () => {
    const { repo, service } = setup();
    const created = await service.start('idle');
    await service.markOnline(created.id);
    await service.destroy(created.id); // → exited

    const after = await service.markOnline(created.id);

    expect(after?.status).toBe('exited');
    expect((await repo.findById(created.id))?.status).toBe('exited');
  });

  it('T-S9: concurrent start() + destroy() leaves no orphan Job', async () => {
    const { repo, client, service } = setup();
    const originalCreate = client.createJob.bind(client);
    let destroyPromise: Promise<unknown> = Promise.resolve();

    client.createJob = async (manifest) => {
      await originalCreate(manifest);
      const containerId = manifest.metadata.labels['zag.cloud/container-id']!;
      // 与 start() 并发触发销毁（受 per-container 串行锁约束）
      destroyPromise = service.destroy(containerId);
    };

    const created = await service.start('idle');
    await destroyPromise;

    expect(await client.getJob(created.name)).toBeNull();
    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('exited');
  });

  it('T-S10: start() reclaims the new Job if the record is concurrently terminal', async () => {
    const { repo, client, service } = setup();
    const originalUpdate = repo.update.bind(repo);
    repo.update = async (id, patch, options) => {
      if (patch.status === 'connecting') {
        // 模拟并发销毁已把记录置为终态：条件写入 creating→connecting 失败
        await originalUpdate(id, { status: 'exited', tokenHash: null });
        return null;
      }
      return originalUpdate(id, patch, options);
    };

    const created = await service.start('idle');

    expect(created.status).toBe('exited');
    expect(await client.getJob(created.name)).toBeNull();
  });

  it('T-S11: list() does not fail a creating record whose Job is not created yet', async () => {
    const { repo, service } = setup();
    const created = await repo.create({
      name: 'zag-worker-pending',
      namespace: 'zag-workers',
      purpose: 'idle',
      image: 'zero-tools/zag-worker:latest',
      status: 'creating',
    });

    const list = await service.list();

    expect(list.find((c) => c.id === created.id)?.status).toBe('creating');
  });

  it('T-S12: reclaimResidualJob migrates a stuck destroying record to exited', async () => {
    const { repo, client, service } = setup();
    const created = await service.start('idle');
    await repo.update(created.id, { status: 'destroying' });
    expect(await client.getJob(created.name)).not.toBeNull();

    const deleted = await service.reclaimResidualJob(created.id);

    expect(deleted).toBe(true);
    expect(await client.getJob(created.name)).toBeNull();
    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('exited');
    expect(stored?.exitedAt).toBeInstanceOf(Date);
    expect(stored?.tokenHash).toBeNull();
  });

  it('T-S13: reclaimResidualJob reclaims a residual Job left on an exited record', async () => {
    const { repo, client, service } = setup();
    const created = await service.start('idle');
    await service.markExited(created.id, '容器正常退出');
    expect(await client.getJob(created.name)).not.toBeNull();

    const deleted = await service.reclaimResidualJob(created.id);

    expect(deleted).toBe(true);
    expect(await client.getJob(created.name)).toBeNull();
    expect((await repo.findById(created.id))?.status).toBe('exited');
  });

  it('T-S14: reclaimResidualJob migrates destroying→exited even when the Job is already gone', async () => {
    const { repo, client, service } = setup();
    const created = await service.start('idle');
    await repo.update(created.id, { status: 'destroying' });
    await client.deleteJob(created.name);

    const deleted = await service.reclaimResidualJob(created.id);

    expect(deleted).toBe(false);
    expect((await repo.findById(created.id))?.status).toBe('exited');
  });

  it('T-S15: destroy CAS miss on the final exited write returns the current state without overwriting', async () => {
    const { repo, service } = setup();
    const created = await service.start('idle');
    await service.markOnline(created.id);

    const originalUpdate = repo.update.bind(repo);
    repo.update = async (id, patch, options) => {
      if (patch.status === 'exited' && options?.fromStatuses?.includes('destroying')) {
        // 模拟并发已将记录转移：CAS 未命中，返回 null 且不改写
        return null;
      }
      return originalUpdate(id, patch, options);
    };

    const result = await service.destroy(created.id);

    expect(result.success).toBe(true);
    expect(result.status).toBe('destroying');
    expect((await repo.findById(created.id))?.status).toBe('destroying');
  });

  it('T-S16: destroy on a stuck destroying record migrates it to exited (问题 50)', async () => {
    const { repo, client, service } = setup();
    const created = await service.start('idle');
    await repo.update(created.id, { status: 'destroying' });
    expect(await client.getJob(created.name)).not.toBeNull();

    const result = await service.destroy(created.id);

    expect(result.success).toBe(true);
    expect(result.deletedJob).toBe(true);
    expect(await client.getJob(created.name)).toBeNull();
    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('exited');
    expect(stored?.exitedAt).toBeInstanceOf(Date);
  });

  it('T-S17: start() CAS miss after a concurrent register must not delete the live Job (问题 58)', async () => {
    const { repo, client, service } = setup();
    const originalUpdate = repo.update.bind(repo);
    repo.update = async (id, patch, options) => {
      if (patch.status === 'connecting') {
        // 模拟 worker 先注册：markOnline 允许 creating→online，随后 start() 的
        // creating→connecting CAS 未命中。
        await originalUpdate(id, { status: 'online', connectedAt: new Date() });
        return null;
      }
      return originalUpdate(id, patch, options);
    };

    const created = await service.start('idle');

    expect(created.status).toBe('online');
    // 已注册的健康容器 Job 不得被 CAS-miss 兜底删除。
    expect(await client.getJob(created.name)).not.toBeNull();
    expect(client.deleteCalls).toHaveLength(0);
  });

  it('T-S18: destroy decides graceful shutdown from the post-CAS state, not the stale snapshot (建议 G)', async () => {
    const { repo, service } = setup();
    const created = await service.start('idle'); // snapshot status = connecting
    const shutdowns: string[] = [];
    service.onShutdown((id) => {
      shutdowns.push(id);
    });

    const originalUpdate = repo.update.bind(repo);
    repo.update = async (id, patch, options) => {
      if (patch.status === 'destroying') {
        // 并发 markOnline 在 destroy 的 CAS 之前把记录置为 online。
        await originalUpdate(id, { status: 'online', connectedAt: new Date() });
      }
      return originalUpdate(id, patch, options);
    };

    await service.destroy(created.id);

    // 即便 destroy 起始快照是 connecting，也要向实际已注册的容器发送 shutdown。
    expect(shutdowns).toEqual([created.id]);
  });

  it('rejects non-idle purposes with a clear message', async () => {
    const { service } = setup();
    await expect(service.start('workflow')).rejects.toBeInstanceOf(UnsupportedPurposeError);
    await expect(service.start('workflow')).rejects.toThrow('该任务类型暂未开放');
  });
});
