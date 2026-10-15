import { describe, it, expect, vi, afterEach } from 'vitest';
import { ContainerService } from './container-service.js';
import { HeartbeatTracker } from './heartbeat-tracker.js';
import { InMemoryK8sClient, type K8sClient, type K8sJobEvent } from './k8s-client.js';
import { K8sJobManager } from './k8s-job-manager.js';
import { StatusSyncService } from './status-sync.js';
import { TokenService } from './token-service.js';
import { InMemoryContainerRepository } from '../repositories/container-repository.js';

const CONNECT_TIMEOUT_MS = 300000;

function setup() {
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
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    shutdownGraceMs: 0,
  });
  const heartbeatTracker = new HeartbeatTracker();
  const statusSync = new StatusSyncService({
    repo,
    k8sClient: client,
    containerService: service,
    heartbeatTracker,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    image: 'zero-tools/zag-worker:latest',
    reconnectDelayMs: 0,
  });
  return { repo, client, tokenService, jobManager, service, heartbeatTracker, statusSync };
}

describe('StatusSyncService', () => {
  it('T-Y1: Job Failed event → failed with preserved exitReason', async () => {
    const { repo, service, statusSync } = setup();
    const created = await service.start('idle');

    const event: K8sJobEvent = {
      type: 'MODIFIED',
      job: {
        name: created.name,
        namespace: 'zag-workers',
        labels: {},
        phase: 'failed',
        containerId: created.id,
        message: 'OOMKilled',
      },
    };
    await statusSync.handleJobEvent(event);

    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.exitReason).toBe('OOMKilled');
  });

  it('T-Y2: Job Succeeded event → exited', async () => {
    const { repo, service, statusSync } = setup();
    const created = await service.start('idle');

    await statusSync.handleJobEvent({
      type: 'MODIFIED',
      job: {
        name: created.name,
        namespace: 'zag-workers',
        labels: {},
        phase: 'succeeded',
        containerId: created.id,
      },
    });

    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('exited');
  });

  it('T-Y3: connecting timeout → failed 回连超时 and does not delete the Job', async () => {
    const { repo, client, statusSync } = setup();
    const now = Date.now();
    const created = await repo.create({
      name: 'zag-worker-timeout',
      namespace: 'zag-workers',
      purpose: 'idle',
      image: 'zero-tools/zag-worker:latest',
      status: 'connecting',
      updatedAt: new Date(now - CONNECT_TIMEOUT_MS - 1000),
    });

    const timedOut = await statusSync.scanTimeouts(now);

    expect(timedOut).toContain(created.id);
    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.exitReason).toBe('回连超时');
    expect(client.deleteCalls).toHaveLength(0);
  });

  it('T-Y4: 3 consecutive missed heartbeats → connecting, then reconnect → online', async () => {
    const { repo, service, heartbeatTracker, statusSync } = setup();
    const t0 = 1_700_000_000_000;
    const created = await repo.create({
      name: 'zag-worker-hb',
      namespace: 'zag-workers',
      purpose: 'idle',
      image: 'zero-tools/zag-worker:latest',
      status: 'online',
      connectedAt: new Date(t0),
    });
    heartbeatTracker.record(created.id, t0);

    // 2 misses (< 3) → still online
    expect(await statusSync.scanHeartbeats(t0 + 2 * 30000)).toEqual([]);
    expect((await repo.findById(created.id))?.status).toBe('online');

    // 3 misses → connecting
    expect(await statusSync.scanHeartbeats(t0 + 3 * 30000)).toEqual([created.id]);
    expect((await repo.findById(created.id))?.status).toBe('connecting');

    // 重连（register 回调 markOnline）→ online
    await service.markOnline(created.id);
    expect((await repo.findById(created.id))?.status).toBe('online');
  });

  it('T-Y5: watch disconnect reconnects, reconciles to K8s truth, and flags orphan jobs', async () => {
    const { repo, client, service, jobManager, statusSync } = setup();
    const created = await service.start('idle');

    // 独立于 watch：K8s 侧 Job 已成功，落库仍 connecting
    client.setPhase(created.name, 'succeeded');

    // 无主 Job（无对应落库记录）
    const orphanManifest = jobManager.buildManifest({
      jobName: 'zag-worker-orphan',
      containerId: 'missing-container-id',
      token: 'missing-container-id.secret',
    });
    await client.createJob(orphanManifest);

    // 建立 watch 后模拟断开 → 自动对账 + 重连
    await statusSync.start();
    expect(client.watcherCount()).toBe(1);
    await statusSync.handleWatchDisconnect(new Error('stream closed'));
    expect(client.watcherCount()).toBe(1);
    statusSync.stop();

    expect((await repo.findById(created.id))?.status).toBe('exited');

    const orphan = await repo.findByName('zag-worker-orphan');
    expect(orphan?.status).toBe('failed');
    expect(orphan?.exitReason).toBe('孤儿 Job');
  });

  it('T-Y6: reconcile reclaims a failed record that still has a Job', async () => {
    const { repo, client, service, statusSync } = setup();
    const created = await service.start('idle');
    await service.markFailed(created.id, '回连超时');
    expect(await client.getJob(created.name)).not.toBeNull();

    await statusSync.reconcile();

    expect(await client.getJob(created.name)).toBeNull();
    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.tokenHash).toBeNull();
  });

  it('T-Y7: a stuck destroying record is reclaimed by the terminal sweep and migrated to exited', async () => {
    const { repo, client, service, statusSync } = setup();
    const created = await service.start('idle');
    // 模拟销毁流程被 SIGTERM 打断：状态卡在 destroying，Job 仍在
    await repo.update(created.id, { status: 'destroying' });
    expect(await client.getJob(created.name)).not.toBeNull();

    const reclaimed = await statusSync.sweepTerminalJobs();

    expect(reclaimed).toContain(created.id);
    expect(await client.getJob(created.name)).toBeNull();
    // 问题 50：契约要求 destroying → exited，巡检后必须迁移终态而非停留在 destroying
    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('exited');
    expect(stored?.exitedAt).toBeInstanceOf(Date);
    expect(stored?.exitReason).toBeTruthy();
    expect(stored?.tokenHash).toBeNull();
  });

  it('T-Y9: sweep reclaims a residual Job on an exited record (问题 50)', async () => {
    const { repo, client, service, statusSync } = setup();
    const created = await service.start('idle');
    // Job succeeded → exited，但 Job 对象仍存在（ttl 尚未回收 / deleteJob 曾失败）
    await service.markExited(created.id, '容器正常退出');
    expect((await repo.findById(created.id))?.status).toBe('exited');
    expect(await client.getJob(created.name)).not.toBeNull();

    const reclaimed = await statusSync.sweepTerminalJobs();

    expect(reclaimed).toContain(created.id);
    expect(await client.getJob(created.name)).toBeNull();
    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('exited');
    expect(stored?.tokenHash).toBeNull();
  });

  it('T-Y10: sweep migrates a stuck destroying record to exited even when its Job is already gone (问题 50)', async () => {
    const { repo, client, service, statusSync } = setup();
    const created = await service.start('idle');
    await repo.update(created.id, { status: 'destroying' });
    // Job 已被删除（例如 deleteJob 成功但进程在写回 exited 前崩溃）
    await client.deleteJob(created.name);
    expect(await client.getJob(created.name)).toBeNull();

    const reclaimed = await statusSync.sweepTerminalJobs();

    // 没有真实删除动作，故不计入 reclaimed；但状态必须迁移
    expect(reclaimed).toEqual([]);
    expect((await repo.findById(created.id))?.status).toBe('exited');
  });

  it('T-Y8: rejecting watch-start / rejecting scan never throws out of start()', async () => {
    vi.useFakeTimers();
    try {
      const repo = new InMemoryContainerRepository();
      const tokenService = new TokenService(repo);
      const jobManager = new K8sJobManager(new InMemoryK8sClient(), {
        namespace: 'zag-workers',
        image: 'zero-tools/zag-worker:latest',
        publicWsEndpoint: 'cloud.example.com:4003',
      });
      const service = new ContainerService(repo, tokenService, jobManager, {
        namespace: 'zag-workers',
        image: 'zero-tools/zag-worker:latest',
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        shutdownGraceMs: 0,
      });
      const failingClient: K8sClient = {
        createJob: async () => {},
        getJob: async () => null,
        listJobs: async () => [],
        deleteJob: async () => {},
        watchJobs: async () => {
          throw new Error('apiserver unreachable');
        },
      };
      const logged: unknown[] = [];
      const statusSync = new StatusSyncService({
        repo,
        k8sClient: failingClient,
        containerService: service,
        heartbeatTracker: new HeartbeatTracker(),
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        image: 'zero-tools/zag-worker:latest',
        reconnectDelayMs: 0,
        logger: {
          info: (...args: unknown[]) => logged.push(args),
          warn: (...args: unknown[]) => logged.push(args),
          error: (...args: unknown[]) => logged.push(args),
        },
      });

      // watch 建立失败不应把 rejection 抛出 start()
      await expect(statusSync.start()).resolves.toBeUndefined();
      expect(logged.length).toBeGreaterThan(0);

      // 周期巡检中的异步 rejection 也不应打挂进程
      repo.findAll = async () => {
        throw new Error('mongo down');
      };
      await vi.advanceTimersByTimeAsync(15000);
      expect(logged.length).toBeGreaterThan(0);

      statusSync.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
