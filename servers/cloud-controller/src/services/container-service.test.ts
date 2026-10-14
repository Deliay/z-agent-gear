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

function tokenOfEndpoint(endpoint: string): string {
  return decodeURIComponent(new URL(endpoint).searchParams.get('token') ?? '');
}

describe('ContainerService', () => {
  it('T-S1: start(idle) persists creating→connecting and injects token via both channels', async () => {
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
    expect(tokenOfEndpoint(env.ZAG_SERVER_ENDPOINT!)).toBe(token);
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
    const policies = client.deleteCalls.map((c) => c.options?.propagationPolicy);
    expect(policies.filter((p) => p === 'Foreground')).toHaveLength(3);
    expect(policies.filter((p) => p === 'Background')).toHaveLength(3);
    expect((await repo.findById(created.id))?.status).toBe('exited');
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

  it('rejects non-idle purposes with a clear message', async () => {
    const { service } = setup();
    await expect(service.start('workflow')).rejects.toBeInstanceOf(UnsupportedPurposeError);
    await expect(service.start('workflow')).rejects.toThrow('该任务类型暂未开放');
  });
});
