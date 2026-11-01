import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ContainerService,
  JobCreationError,
  UnsupportedPurposeError,
  type ContainerServiceConfig,
  type ContainerServiceHooks,
  type StartHarnessOptions,
} from './container-service.js';
import { InMemoryK8sClient } from './k8s-client.js';
import { K8sJobManager } from './k8s-job-manager.js';
import { TokenService } from './token-service.js';
import { SecretStore, type HarnessSecrets } from './secret-store.js';
import { InMemoryContainerRepository } from '../repositories/container-repository.js';
import { createTestLogger, type TestLogger } from '../observability/testing.js';
import { RecordingExporter } from '../observability/recording-exporter.js';
import { shutdownTelemetry, startTelemetry } from '../observability/telemetry.js';

function setup(
  overrides: Partial<ContainerServiceConfig> = {},
  extras: { hooks?: ContainerServiceHooks; secretStore?: SecretStore } = {},
) {
  const repo = new InMemoryContainerRepository();
  const client = new InMemoryK8sClient();
  const tokenService = new TokenService(repo);
  const jobManager = new K8sJobManager(client, {
    namespace: 'zag-workers',
    image: 'zero-tools/zag-worker:latest',
    runtimeClassName: 'sysbox-runc',
    publicWsEndpoint: 'cloud.example.com:4003',
  });
  const secretStore = extras.secretStore ?? new SecretStore();
  const testLog: TestLogger = createTestLogger();
  const service = new ContainerService(
    repo,
    tokenService,
    jobManager,
    {
      namespace: 'zag-workers',
      image: 'zero-tools/zag-worker:latest',
      connectTimeoutMs: 300000,
      shutdownGraceMs: 0,
      ...overrides,
    },
    testLog.logger,
    extras.hooks ?? {},
    secretStore,
  );
  return { repo, client, tokenService, jobManager, service, secretStore, testLog };
}

function harnessSecrets(overrides: Partial<HarnessSecrets> = {}): HarnessSecrets {
  return {
    hostEndpoint: 'wss://controller.example.com',
    hostKey: 'zag_k_1_host-secret',
    modelApiKey: 'zag_sk_model-secret',
    modelBaseUrl: 'http://admin-api:8002/v1',
    modelIds: '["model-a"]',
    defaultWorkspace: '/home/worker/workspace',
    ...overrides,
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
    tenantId: 'tenant-1',
    workspaceId: 'ws-1',
    expiresAt: new Date(Date.now() + 3600_000),
    secrets: harnessSecrets(),
    ...overrides,
  };
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

  it('R2-20: destroy passes the real failure reason to the worker shutdown handler', async () => {
    const { service } = setup();
    const created = await service.start('harness', 'ck-1', [], [], harnessOptions());
    await service.markOnline(created.id);
    const reasons: Array<string | undefined> = [];
    service.onShutdown((_id, reason) => {
      reasons.push(reason);
    });

    await service.destroy(created.id, { reason: '必须工作负载「opencode」初始化失败' });

    expect(reasons).toEqual(['必须工作负载「opencode」初始化失败']);
  });

  it('T-WD15: destroy(id, { reason }) overrides exitReason; no reason stays 强制销毁; delete failure keeps suffix', async () => {
    const { repo, service } = setup();

    // 活跃路径：自定义 reason 覆盖 exitReason
    const a = await service.start('idle');
    await service.markOnline(a.id);
    await service.destroy(a.id, { reason: '必须工作负载「X」初始化失败' });
    expect((await repo.findById(a.id))?.exitReason).toBe('必须工作负载「X」初始化失败');

    // 不传 reason：行为与现状一致
    const b = await service.start('idle');
    await service.markOnline(b.id);
    await service.destroy(b.id);
    expect((await repo.findById(b.id))?.exitReason).toBe('强制销毁');

    // Job 删除失败：保留后缀
    const { repo: repo2, client: client2, service: service2 } = setup();
    const c = await service2.start('idle');
    await service2.markOnline(c.id);
    client2.failDeleteTimes = 100;
    await service2.destroy(c.id, { reason: '必须工作负载「Y」初始化失败' });
    expect((await repo2.findById(c.id))?.exitReason).toBe(
      '必须工作负载「Y」初始化失败（Job 删除失败，需人工清理）',
    );

    // forceDestroy 为 destroy(id, { reason }) 的语义等价封装
    const d = await service.start('idle');
    await service.markOnline(d.id);
    await service.forceDestroy(d.id, '必须工作负载「Z」初始化失败');
    expect((await repo.findById(d.id))?.exitReason).toBe('必须工作负载「Z」初始化失败');
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

  it('T-S19: 从未兼容注册（connectedAt=null）的容器 destroy 不发 shutdown、不等待宽限，仍删 Job 并收口', async () => {
    const { repo, client, service } = setup({ shutdownGraceMs: 120 });
    const created = await service.start('idle'); // 版本被拒的容器停在 connecting，从未写 connectedAt
    expect(created.status).toBe('connecting');
    expect((await repo.findById(created.id))?.connectedAt).toBeNull();

    const shutdowns: string[] = [];
    service.onShutdown((id) => {
      shutdowns.push(id);
    });

    const startedAt = Date.now();
    const result = await service.destroy(created.id);
    const elapsed = Date.now() - startedAt;

    // 未完成兼容注册：不发 shutdown、不等待 shutdownGraceMs（120ms），直接删 Job。
    expect(shutdowns).toEqual([]);
    expect(elapsed).toBeLessThan(100);
    expect(result.success).toBe(true);
    expect(result.deletedJob).toBe(true);
    expect(await client.getJob(created.name)).toBeNull();

    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('exited');
    expect(stored?.exitReason).toBe('强制销毁');
    expect(stored?.tokenHash).toBeNull();
  });

  it('rejects non-idle purposes with a clear message', async () => {
    const { service } = setup();
    await expect(service.start('workflow')).rejects.toBeInstanceOf(UnsupportedPurposeError);
    await expect(service.start('workflow')).rejects.toThrow('该任务类型暂未开放');
  });
});

describe('ContainerService workload state machine', () => {
  it('T-CS1: start(idle, null, workloadIds) 去重保序落库，缺省为 []', async () => {
    const { repo, service } = setup();

    const created = await service.start('idle', null, ['a', 'b', 'a']);
    expect((await repo.findById(created.id))?.workloadIds).toEqual(['a', 'b']);
    expect(created.status).toBe('connecting');

    const plain = await service.start('idle');
    expect((await repo.findById(plain.id))?.workloadIds).toEqual([]);
  });

  it('T-CC1: start 携带 workloadPlan → 落库 plan 且 workloadIds 由 plan 派生保序', async () => {
    const { repo, service } = setup();

    const created = await service.start('idle', null, [], [
      { workloadId: 'dep', params: {}, implicit: true, required: false },
      { workloadId: 'app', params: { version: '22', pm: ['pnpm'] }, implicit: false, required: false },
    ]);

    const stored = await repo.findById(created.id);
    expect(stored?.workloadPlan).toEqual([
      { workloadId: 'dep', params: {}, implicit: true, required: false },
      { workloadId: 'app', params: { version: '22', pm: ['pnpm'] }, implicit: false, required: false },
    ]);
    // workloadIds 由 plan 派生（保序），兼容旧版读取
    expect(stored?.workloadIds).toEqual(['dep', 'app']);
    expect(created.status).toBe('connecting');
  });

  it('T-CC1-REQ: workloadPlan.required 落库（缺省归一 false，显式 true 保留）', async () => {
    const { repo, service } = setup();

    const created = await service.start('idle', null, [], [
      { workloadId: 'must', params: {}, implicit: false, required: true },
      { workloadId: 'opt', params: {}, implicit: false },
    ]);

    const stored = await repo.findById(created.id);
    expect(stored?.workloadPlan).toEqual([
      { workloadId: 'must', params: {}, implicit: false, required: true },
      { workloadId: 'opt', params: {}, implicit: false, required: false },
    ]);
  });

  it('T-CC1b: plan 与 workloadIds 同时下发时以 plan 为准；plan 派生时去重', async () => {
    const { repo, service } = setup();

    const created = await service.start('idle', null, ['legacy'], [
      { workloadId: 'a', params: {}, implicit: false },
      { workloadId: 'a', params: {}, implicit: false },
      { workloadId: 'b', params: {}, implicit: true },
    ]);

    const stored = await repo.findById(created.id);
    expect(stored?.workloadIds).toEqual(['a', 'b']);
    expect(stored?.workloadPlan).toHaveLength(3);
  });

  it('T-CC2: start 仅携带 workloadIds → 行为与现状一致（去重保序，plan 为空）', async () => {
    const { repo, service } = setup();

    const created = await service.start('idle', null, ['b', 'a', 'b']);

    const stored = await repo.findById(created.id);
    expect(stored?.workloadIds).toEqual(['b', 'a']);
    expect(stored?.workloadPlan).toEqual([]);

    const plain = await service.start('idle');
    expect((await repo.findById(plain.id))?.workloadPlan).toEqual([]);
  });

  it('T-CC2b: deriveWorkloadIdsFromPlan=false → workloadIds 按选择顺序，plan 仅用于执行', async () => {
    const { repo, service } = setup();

    const created = await service.start(
      'idle',
      null,
      ['legacy'],
      [
        { workloadId: 'dep', params: {}, implicit: true },
        { workloadId: 'legacy', params: {}, implicit: false },
      ],
      { deriveWorkloadIdsFromPlan: false },
    );

    const stored = await repo.findById(created.id);
    // 契约 A.2.2：仅 workloadIds 的旧版请求按选择顺序落库（不含隐式依赖）
    expect(stored?.workloadIds).toEqual(['legacy']);
    expect(stored?.workloadPlan).toEqual([
      { workloadId: 'dep', params: {}, implicit: true, required: false },
      { workloadId: 'legacy', params: {}, implicit: false, required: false },
    ]);
  });

  it('T-CS2: markInitializing 写 currentWorkloadName，markOnline/markConnecting 清空', async () => {
    const { repo, service } = setup();
    const created = await service.start('idle');

    const initializing = await service.markInitializing(created.id, 'wl-1');
    expect(initializing?.status).toBe('initializing');
    expect(initializing?.currentWorkloadName).toBe('wl-1');
    expect(initializing?.connectedAt).toBeInstanceOf(Date);

    const online = await service.markOnline(created.id);
    expect(online?.status).toBe('online');
    expect(online?.currentWorkloadName).toBeNull();

    await service.markInitializing(created.id, 'wl-2');
    const connecting = await service.markConnecting(created.id);
    expect(connecting?.status).toBe('connecting');
    expect(connecting?.currentWorkloadName).toBeNull();
  });

  it('T-CS2b: markExited/markFailed 清空 currentWorkloadName', async () => {
    const { service } = setup();
    const first = await service.start('idle');
    await service.markInitializing(first.id, 'wl-1');
    const exited = await service.markExited(first.id, '容器正常退出');
    expect(exited?.currentWorkloadName).toBeNull();

    const second = await service.start('idle');
    await service.markInitializing(second.id, 'wl-2');
    const failed = await service.markFailed(second.id, '回连超时');
    expect(failed?.currentWorkloadName).toBeNull();
  });

  it('T-CS3: initializing 容器可被销毁（ACTIVE 集合包含 initializing）', async () => {
    const { repo, client, service } = setup();
    const created = await service.start('idle');
    await service.markInitializing(created.id, 'wl-1');
    const shutdowns: string[] = [];
    service.onShutdown((id) => {
      shutdowns.push(id);
    });

    const result = await service.destroy(created.id);

    expect(result.success).toBe(true);
    expect(result.deletedJob).toBe(true);
    expect(shutdowns).toEqual([created.id]);
    expect(await client.getJob(created.name)).toBeNull();
    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('exited');
    expect(stored?.currentWorkloadName).toBeNull();
  });

  it('T-CC2/T-CC7: harness 启动落库新字段、Job env 与 TTL、secret 仅存内存', async () => {
    const { repo, client, service, secretStore } = setup();
    const expiresAt = new Date(Date.now() + 3600_000);
    const secrets = harnessSecrets();

    const created = await service.start(
      'harness',
      'ck-1',
      ['wl-1'],
      [{ workloadId: 'wl-1', params: {}, implicit: false, required: true }],
      harnessOptions({ expiresAt, secrets }),
    );

    expect(created.purpose).toBe('harness');
    const stored = await repo.findById(created.id);
    expect(stored).toMatchObject({
      purpose: 'harness',
      hostId: 'host-1',
      hostName: 'my-pc',
      harnessTypes: ['opencode'],
      controllerKeyId: 'ck-1',
      containerApiKeyId: 'ak-1',
      refId: 'ck-1',
      userId: 'user-1',
    });
    expect(stored?.expiresAt?.getTime()).toBe(expiresAt.getTime());

    const env = client.getEnv(created.name);
    expect(env.ZAG_SERVER_ENDPOINT).toContain('/worker');
    expect(env.ZAG_CONTROLLER_KEY).toBeTruthy();
    expect(env.ZAG_HOST_ENDPOINT).toBe(secrets.hostEndpoint);
    expect(env.ZAG_HOST_KEY).toBe(secrets.hostKey);
    expect(env.ZAG_HOST_NAME).toBe('my-pc');
    expect(env.ZAG_HARNESS_TYPES).toBe('opencode');
    expect(env.ZAG_DEFAULT_WORKSPACE).toBe(secrets.defaultWorkspace);
    expect(env.ZAG_USER_TYPE).toBe('front_user');
    expect(env.ZAG_USER_ID).toBe('user-1');
    // 模型 Key 不进入 Job env（只走 workload:run.env）
    expect(env.ZAG_MODEL_API_KEY).toBeUndefined();

    const manifest = client.getManifest(created.name)!;
    // 最长运行时间无限制：Job 不再设置 activeDeadlineSeconds
    expect(manifest.spec).not.toHaveProperty('activeDeadlineSeconds');

    expect(secretStore.get(created.id)).toEqual(secrets);
    // secret 不落库：实体无 secrets 字段
    expect(JSON.stringify(stored)).not.toContain(secrets.modelApiKey);
    expect(JSON.stringify(stored)).not.toContain(secrets.hostKey);
  });

  it('T-CC1/T-CC8: idle 启动行为不变（Job env 仅基础两项、无 secret 写入）', async () => {
    const { client, service, secretStore } = setup();
    const created = await service.start('idle');

    const manifest = client.getManifest(created.name)!;
    expect(manifest.spec.template.spec.containers[0]!.env.map((entry) => entry.name)).toEqual([
      'ZAG_SERVER_ENDPOINT',
      'ZAG_CONTROLLER_KEY',
    ]);
    expect(manifest.spec).not.toHaveProperty('activeDeadlineSeconds');
    expect(secretStore.size).toBe(0);
  });

  it('T-CC3: 非 idle/harness 的 purpose 仍被拒绝', async () => {
    const { service } = setup();
    for (const purpose of ['admin-task', 'workflow', 'session'] as const) {
      await expect(service.start(purpose)).rejects.toBeInstanceOf(UnsupportedPurposeError);
    }
  });

  it('T-CC19: harness 首次 online 触发 onReady（不依赖计费），重复 online 不重复', async () => {
    const ready: string[] = [];
    const { service } = setup(
      {},
      {
        hooks: {
          onReady: (container) => {
            ready.push(`${container.purpose}:${container.id}`);
          },
        },
      },
    );
    const idle = await service.start('idle');
    await service.markOnline(idle.id);
    // idle 无计费账户：不触发（保持既有计费语义）
    expect(ready).toEqual([]);

    const harness = await service.start('harness', 'ck-1', [], [], harnessOptions());
    await service.markOnline(harness.id);
    expect(ready).toEqual([`harness:${harness.id}`]);

    await service.markOnline(harness.id);
    expect(ready).toHaveLength(1);
  });

  it('T-CC14/T-CC20: harness 终态触发 onDestroyed 并清理 secret（无计费也触发）', async () => {
    const destroyed: string[] = [];
    const { service, secretStore } = setup(
      {},
      {
        hooks: {
          onDestroyed: (container) => {
            destroyed.push(`${container.purpose}:${container.status}:${container.id}`);
          },
        },
      },
    );

    const harness = await service.start('harness', 'ck-1', [], [], harnessOptions());
    expect(secretStore.get(harness.id)).not.toBeNull();
    await service.markOnline(harness.id);
    await service.destroy(harness.id);

    expect(destroyed).toEqual([`harness:exited:${harness.id}`]);
    expect(secretStore.get(harness.id)).toBeNull();

    // Job 异常退出（markExited / markFailed）同样清理 secret 并触发 destroyed
    const exited = await service.start('harness', 'ck-1', [], [], harnessOptions());
    await service.markOnline(exited.id);
    await service.markExited(exited.id, '容器正常退出');
    expect(destroyed).toContain(`harness:exited:${exited.id}`);
    expect(secretStore.get(exited.id)).toBeNull();

    const failed = await service.start('harness', 'ck-1', [], [], harnessOptions());
    await service.markOnline(failed.id);
    await service.markFailed(failed.id, '容器异常退出');
    expect(destroyed).toContain(`harness:failed:${failed.id}`);
    expect(secretStore.get(failed.id)).toBeNull();
  });

  it('R2-4: mustFailure is preserved into the terminal onDestroyed callback', async () => {
    let captured: { mustFailure: boolean; exitReason: string | null } | null = null;
    const { repo, service } = setup(
      {},
      {
        hooks: {
          onDestroyed: (container) => {
            captured = {
              mustFailure: container.mustFailure,
              exitReason: container.exitReason,
            };
          },
        },
      },
    );
    const harness = await service.start('harness', 'ck-1', [], [], harnessOptions());
    await service.markOnline(harness.id);
    // dispatcher 在锁内先落 mustFailure + exitReason，再锁外 forceDestroy
    await repo.update(harness.id, {
      mustFailure: true,
      exitReason: '必须工作负载「opencode」初始化失败',
    });

    await service.destroy(harness.id, { reason: '必须工作负载「opencode」初始化失败' });

    expect(captured).toEqual({
      mustFailure: true,
      exitReason: '必须工作负载「opencode」初始化失败',
    });
  });

  it('T-CC1: idle 无计费时终态不触发 onDestroyed（既有语义不变）', async () => {
    const destroyed: string[] = [];
    const { service } = setup(
      {},
      {
        hooks: {
          onDestroyed: (container) => {
            destroyed.push(container.id);
          },
        },
      },
    );
    const idle = await service.start('idle');
    await service.markOnline(idle.id);
    await service.destroy(idle.id);
    expect(destroyed).toEqual([]);
  });

  it('T-CC17: 历史容器（无新字段）读取与销毁正常，新字段归一为 null/[]', async () => {
    const { repo, service, secretStore } = setup();
    // 模拟旧记录：仅含历史必填字段（无 hostId/harnessTypes/expiresAt 等）。
    const legacy = await repo.create({
      name: 'zag-worker-legacy',
      namespace: 'zag-workers',
      purpose: 'idle',
      image: 'zero-tools/zag-worker:latest',
      status: 'online',
      connectedAt: new Date(),
    });

    const stored = await repo.findById(legacy.id);
    expect(stored).toMatchObject({
      purpose: 'idle',
      hostId: null,
      hostName: null,
      harnessTypes: [],
      controllerKeyId: null,
      containerApiKeyId: null,
      expiresAt: null,
    });

    const result = await service.destroy(legacy.id);
    expect(result.success).toBe(true);
    expect((await repo.findById(legacy.id))?.status).toBe('exited');
    // 历史容器无 secret，删除 secret 幂等无害
    expect(secretStore.get(legacy.id)).toBeNull();
  });
});

describe('T-OBS15 Job env 观测注入（F12）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('未配置采集端 → 仅注入 OTEL_SDK_DISABLED=true（业务 env 不变、顺序先业务后观测）', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
    vi.stubEnv('OTEL_SDK_DISABLED', '');
    const { client, service } = setup();
    const created = await service.start('harness', 'ck-1', [], [], harnessOptions());

    const manifest = client.getManifest(created.name)!;
    expect(manifest.spec.template.spec.containers[0]!.env.map((e) => e.name)).toEqual([
      'ZAG_SERVER_ENDPOINT',
      'ZAG_CONTROLLER_KEY',
      'ZAG_HOST_ENDPOINT',
      'ZAG_HOST_KEY',
      'ZAG_HOST_NAME',
      'ZAG_HARNESS_TYPES',
      'ZAG_DEFAULT_WORKSPACE',
      'ZAG_USER_TYPE',
      'ZAG_USER_ID',
      'OTEL_SDK_DISABLED',
    ]);
    const env = client.getEnv(created.name);
    expect(env.OTEL_SDK_DISABLED).toBe('true');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
    expect(env.OTEL_SERVICE_NAME).toBeUndefined();
    expect(env.OTEL_TRACES_SAMPLER).toBeUndefined();
    expect(env.OTEL_TRACES_SAMPLER_ARG).toBeUndefined();
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
    expect(env.ZAG_INIT_TRACEPARENT).toBeUndefined();
  });

  it('配置采集端（SDK 未运行/无活跃 span）→ OTEL_* 透传 + OTEL_RESOURCE_ATTRIBUTES 五维；无 ZAG_INIT_TRACEPARENT；headers 不入日志', async () => {
    const headersValue = 'x-scope-orgid=secret-token-123';
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector:4318');
    vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', headersValue);
    vi.stubEnv('OTEL_TRACES_SAMPLER', undefined);
    vi.stubEnv('OTEL_TRACES_SAMPLER_ARG', undefined);
    vi.stubEnv('OTEL_SDK_DISABLED', '');
    const { client, service, testLog } = setup();
    const created = await service.start('harness', 'ck-1', [], [], harnessOptions());

    const env = client.getEnv(created.name);
    expect(env.OTEL_SDK_DISABLED).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://collector:4318');
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe(headersValue);
    expect(env.OTEL_SERVICE_NAME).toBe('agent-gear');
    expect(env.OTEL_TRACES_SAMPLER).toBe('parentbased_traceidratio');
    expect(env.OTEL_TRACES_SAMPLER_ARG).toBe('1.0');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      `zag.container.id=${created.id},zag.cloud.host.id=host-1,zag.user.id=user-1,zag.tenant.id=tenant-1,zag.workspace.id=ws-1`,
    );
    // 无活跃 span（SDK 未启动）→ 不注入 ZAG_INIT_TRACEPARENT，避免容器内建出无效 link
    expect(env.ZAG_INIT_TRACEPARENT).toBeUndefined();

    // OTEL_EXPORTER_OTLP_HEADERS 的值绝不出现在任何日志输出
    expect(testLog.records.length).toBeGreaterThan(0);
    expect(JSON.stringify(testLog.records)).not.toContain('secret-token-123');
  });

  it('OTEL_TRACES_SAMPLER/ARG 可由 env 覆盖；tenantId/workspaceId 缺省回退空串', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector:4318');
    vi.stubEnv('OTEL_TRACES_SAMPLER', 'traceidratio');
    vi.stubEnv('OTEL_TRACES_SAMPLER_ARG', '0.5');
    vi.stubEnv('OTEL_SDK_DISABLED', '');
    const { client, service } = setup();
    const created = await service.start(
      'harness',
      'ck-1',
      [],
      [],
      harnessOptions({ tenantId: null, workspaceId: null }),
    );

    const env = client.getEnv(created.name);
    expect(env.OTEL_TRACES_SAMPLER).toBe('traceidratio');
    expect(env.OTEL_TRACES_SAMPLER_ARG).toBe('0.5');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      `zag.container.id=${created.id},zag.cloud.host.id=host-1,zag.user.id=user-1,zag.tenant.id=,zag.workspace.id=`,
    );
  });

  it('结构化日志按 pino 签名输出（warn/error 带 component/jobName/err 字段，msg 不拼接变量）', async () => {
    const { client, service, testLog } = setup();
    // 缺 AGENT_API_URL：buildHarnessJobEnv 记 warn（component=harness）
    const created = await service.start('harness', 'ck-1', [], [], harnessOptions());
    await service.markOnline(created.id);
    client.failDeleteTimes = 100;
    await service.destroy(created.id);

    const warn = testLog.records.find((r) => r.msg.includes('AGENT_API_URL'));
    expect(warn?.level).toBe('warn');
    expect(warn?.component).toBe('harness');

    const error = testLog.records.find((r) => r.msg === 'Failed to delete job');
    expect(error?.level).toBe('error');
    expect(error?.jobName).toBe(created.name);
    expect(error?.err).toBeTruthy();
  });
});

describe('T-OBS15 container.start span 与 ZAG_INIT_TRACEPARENT（SDK 运行）', () => {
  it('注入 ZAG_INIT_TRACEPARENT 且与 container.start span 同 trace；span 属性含容器标识', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
    vi.stubEnv('OTEL_METRICS_ENABLED', 'false');
    vi.stubEnv('OTEL_SDK_DISABLED', '');
    const mem = new RecordingExporter();
    startTelemetry({ traceExporter: mem });

    const { client, service } = setup();
    const created = await service.start('harness', 'ck-1', [], [], harnessOptions());
    const env = client.getEnv(created.name);
    expect(env.ZAG_INIT_TRACEPARENT).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    await shutdownTelemetry();
    const span = mem.spans.find((s) => s.name === 'container.start');
    expect(span).toBeDefined();
    expect(span!.attributes['zag.container.purpose']).toBe('harness');
    expect(span!.attributes['zag.container.id']).toBe(created.id);
    expect(span!.attributes['zag.cloud.host.id']).toBe('host-1');
    expect(span!.attributes['zag.user.id']).toBe('user-1');
    expect(span!.attributes['zag.tenant.id']).toBe('tenant-1');
    expect(span!.attributes['zag.workspace.id']).toBe('ws-1');
    // 创建链路 traceparent 与 container.start span 同 trace（容器内 startup span 以 link 关联）
    expect(env.ZAG_INIT_TRACEPARENT).toContain(`-${span!.spanContext().traceId}-`);
    vi.unstubAllEnvs();
  });
});
