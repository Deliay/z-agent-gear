import { describe, it, expect } from 'vitest';
import {
  BillingEventPublisher,
  InMemoryOutboxRepository,
  type BillingEventMessage,
  type EventTransport,
} from './billing-event-publisher.js';
import { ContainerService } from './container-service.js';
import { InMemoryK8sClient } from './k8s-client.js';
import { K8sJobManager } from './k8s-job-manager.js';
import { TokenService } from './token-service.js';
import { InMemoryContainerRepository } from '../repositories/container-repository.js';
import type { CloudContainerEntity } from '../repositories/container-repository.js';

function setupService(hooks: {
  onReady?: (container: CloudContainerEntity) => void;
  onDestroyed?: (container: CloudContainerEntity) => void;
}) {
  const repo = new InMemoryContainerRepository();
  const client = new InMemoryK8sClient();
  const tokenService = new TokenService(repo);
  const jobManager = new K8sJobManager(client, {
    namespace: 'zag-workers',
    image: 'zero-tools/zag-worker:latest',
    runtimeClassName: 'sysbox-runc',
    publicWsEndpoint: 'cloud.example.com:4003',
  });
  const service = new ContainerService(
    repo,
    tokenService,
    jobManager,
    {
      namespace: 'zag-workers',
      image: 'zero-tools/zag-worker:latest',
      connectTimeoutMs: 300000,
      shutdownGraceMs: 0,
    },
    console,
    hooks,
  );
  return { repo, service };
}

describe('cloud-controller 计费源头', () => {
  it('T-CC-B1/B2: 首次 markOnline 写 billingStartedAt 并触发一次 ready，重复不重置', async () => {
    const ready: CloudContainerEntity[] = [];
    const { repo, service } = setupService({ onReady: (container) => ready.push(container) });
    const created = await service.start('idle', null, [], null, { billingAccountId: 'acct-1' });

    const first = await service.markOnline(created.id);
    expect(first?.billingStartedAt).toBeInstanceOf(Date);
    expect(ready).toHaveLength(1);

    const startedAt = first?.billingStartedAt?.getTime();
    await service.markOnline(created.id);
    const stored = await repo.findById(created.id);
    expect(stored?.billingStartedAt?.getTime()).toBe(startedAt);
    expect(ready).toHaveLength(1);

    // 两条就绪路径（初始化完成后 markOnline / 无脚本直通）共用同一 CAS 逻辑
    await service.markInitializing(created.id, 'setup');
    const again = await service.markOnline(created.id);
    expect(again?.billingStartedAt?.getTime()).toBe(startedAt);
    expect(ready).toHaveLength(1);
  });

  it('R-1: 发布失败即停止本轮（后续事件不得先发，避免顺序翻转）', async () => {
    const repo = new InMemoryOutboxRepository('cloud-controller');
    const published: string[] = [];
    let failReady = true;
    const transport: EventTransport = {
      publish: async (_routingKey: string, message: BillingEventMessage) => {
        if (message.eventType === 'container.ready' && failReady) {
          failReady = false;
          throw new Error('broker down');
        }
        published.push(message.eventId);
      },
      close: async () => {},
    };
    const publisher = new BillingEventPublisher({ repository: repo, transport, intervalMs: 100000 });
    await publisher.enqueue({
      eventId: 'container.ready:ord',
      eventType: 'container.ready',
      occurredAt: new Date().toISOString(),
      accountId: 'acct-1',
      resourceId: 'ord',
      payload: {},
    });
    await publisher.enqueue({
      eventId: 'container.destroyed:ord',
      eventType: 'container.destroyed',
      occurredAt: new Date().toISOString(),
      accountId: 'acct-1',
      resourceId: 'ord',
      payload: {},
    });

    // 首条发布失败：本轮 0 条，且 destroyed **不得**先于 ready 发布。
    expect(await publisher.relayOnce()).toBe(0);
    expect(published).toEqual([]);

    // 下一轮按 createdAt 顺序重试，先 ready 后 destroyed。
    expect(await publisher.relayOnce()).toBe(2);
    expect(published).toEqual(['container.ready:ord', 'container.destroyed:ord']);
    await publisher.stop();
  });

  it('O-1: SIGTERM 前排空在途计费钩子', async () => {
    let resolveHook: (() => void) | null = null;
    const { service } = setupService({
      onReady: () =>
        new Promise<void>((resolve) => {
          resolveHook = resolve;
        }),
    });
    const created = await service.start('idle', null, [], null, { billingAccountId: 'acct-drain' });
    await service.markOnline(created.id);

    let drained = false;
    const drain = service.drainBillingHooks().then(() => {
      drained = true;
    });
    // 钩子未结束前 drain 不应完成。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drained).toBe(false);
    resolveHook?.();
    await drain;
    expect(drained).toBe(true);
  });

  it('T-CC-B6/B9: outbox 失败重试保留，后续补投成功；hook 抛错不阻断生命周期', async () => {
    const repo = new InMemoryOutboxRepository();
    const published: string[] = [];
    let failOnce = true;
    const transport: EventTransport = {
      publish: async (_routingKey: string, message: BillingEventMessage) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('broker down');
        }
        published.push(message.eventId);
      },
      close: async () => {},
    };
    const publisher = new BillingEventPublisher({ repository: repo, transport, intervalMs: 10000 });
    await publisher.enqueue({
      eventId: 'container.ready:c1',
      eventType: 'container.ready',
      occurredAt: new Date().toISOString(),
      accountId: 'acct-1',
      resourceId: 'c1',
      payload: { billingStartedAt: new Date().toISOString() },
    });
    expect(await publisher.relayOnce()).toBe(0);
    expect(repo.pending()).toHaveLength(1);
    expect(await publisher.relayOnce()).toBe(1);
    expect(published).toEqual(['container.ready:c1']);
    expect(repo.pending()).toHaveLength(0);

    // 重复入队幂等
    await publisher.enqueue({
      eventId: 'container.ready:c1',
      eventType: 'container.ready',
      occurredAt: new Date().toISOString(),
      accountId: 'acct-1',
      resourceId: 'c1',
      payload: {},
    });
    await publisher.relayOnce();
    expect(published).toEqual(['container.ready:c1']);
    await publisher.stop();
  });

  it('T-CC-B4/B5: 已计费容器销毁触发 destroyed；未就绪即销毁不触发', async () => {
    const destroyed: CloudContainerEntity[] = [];
    const { service } = setupService({ onDestroyed: (container) => destroyed.push(container) });

    const billed = await service.start('idle', null, [], null, { billingAccountId: 'acct-1' });
    await service.markOnline(billed.id);
    await service.destroy(billed.id);
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]!.billingStartedAt).toBeInstanceOf(Date);
    expect(destroyed[0]!.exitedAt).toBeInstanceOf(Date);

    const unbilled = await service.start('idle');
    await service.markOnline(unbilled.id);
    await service.destroy(unbilled.id);
    expect(destroyed).toHaveLength(1);
  });

  it('T-CC-B7: destroy 带 reason 写入 exitReason', async () => {
    const { repo, service } = setupService({});
    const created = await service.start('idle');
    await service.markOnline(created.id);
    await service.destroy(created.id, { reason: '余额不足超过 10 分钟，强制销毁' });
    const stored = await repo.findById(created.id);
    expect(stored?.exitReason).toBe('余额不足超过 10 分钟，强制销毁');
  });

  it('T-CC-B9: 计费钩子抛错不阻断 markOnline/destroy 生命周期', async () => {
    const { repo, service } = setupService({
      onReady: () => {
        throw new Error('outbox unavailable');
      },
      onDestroyed: () => {
        throw new Error('outbox unavailable');
      },
    });
    const created = await service.start('idle', null, [], null, { billingAccountId: 'acct-1' });
    const online = await service.markOnline(created.id);
    expect(online?.status).toBe('online');
    expect(online?.billingStartedAt).toBeInstanceOf(Date);

    const result = await service.destroy(created.id);
    expect(result.success).toBe(true);
    expect((await repo.findById(created.id))?.status).toBe('exited');
  });

  it('T-CC-B3: 无脚本 register 直通路径（connecting→online）同样写入计费起点并投递', async () => {
    const ready: CloudContainerEntity[] = [];
    const { service } = setupService({ onReady: (container) => ready.push(container) });
    const created = await service.start('idle', null, [], null, { billingAccountId: 'acct-2' });
    // 无初始化脚本：worker register 接受即 online（不经过 initializing）
    const online = await service.markOnline(created.id);
    expect(online?.status).toBe('online');
    expect(online?.billingStartedAt).toBeInstanceOf(Date);
    expect(ready).toHaveLength(1);
  });

  it('T-D2: 卡死 destroying 恢复保留既有 exitReason（不覆写强拆原因）', async () => {
    const { repo, service } = setupService({});
    const created = await service.start('idle');
    await repo.update(
      created.id,
      { status: 'destroying', exitReason: '必须工作负载「setup」初始化失败' },
      { fromStatuses: ['creating', 'connecting'] },
    );
    await service.reclaimResidualJob(created.id);
    const stored = await repo.findById(created.id);
    expect(stored?.status).toBe('exited');
    expect(stored?.exitReason).toBe('必须工作负载「setup」初始化失败');
  });

  it('T-R2/B4: outbox 原子认领 + 租约 + attempts 封顶隔离（cloud-controller relay）', async () => {
    const repo = new InMemoryOutboxRepository('cloud-controller');
    await repo.enqueue({
      eventId: 'container.ready:r1',
      eventType: 'container.ready',
      occurredAt: new Date().toISOString(),
      accountId: 'acct-1',
      resourceId: 'r1',
      payload: {},
    });

    // 同一租约窗口内，第二个认领者拿不到。
    const first = await repo.claim('cloud-controller', 10, 'p1', 30000);
    const second = await repo.claim('cloud-controller', 10, 'p2', 30000);
    expect(first.map((r) => r.eventId)).toEqual(['container.ready:r1']);
    expect(second).toHaveLength(0);

    // 租约过期（leaseMs=0）后可被再次认领。
    const afterLease = await repo.claim('cloud-controller', 10, 'p2', 0);
    expect(afterLease.map((r) => r.eventId)).toEqual(['container.ready:r1']);

    // attempts 达上限 → failed 隔离，不再被认领。
    await repo.markFailed('container.ready:r1', 'boom', 3);
    await repo.markFailed('container.ready:r1', 'boom', 3);
    await repo.markFailed('container.ready:r1', 'boom', 3);
    expect(repo.pending()[0]?.failed).toBe(true);
    expect(await repo.claim('cloud-controller', 10, 'p3', 0)).toHaveLength(0);
  });

  it('T-R2/B4: 两个 relay 共享 outbox 时同一事件只发布一次（不双发）', async () => {
    const repo = new InMemoryOutboxRepository('cloud-controller');
    const published: string[] = [];
    const transport = {
      publish: async (_routingKey: string, message: BillingEventMessage) => {
        published.push(message.eventId);
      },
      close: async () => {},
    };
    const p1 = new BillingEventPublisher({ repository: repo, transport, intervalMs: 100000 });
    const p2 = new BillingEventPublisher({ repository: repo, transport, intervalMs: 100000 });
    await p1.enqueue({
      eventId: 'container.destroyed:c1',
      eventType: 'container.destroyed',
      occurredAt: new Date().toISOString(),
      accountId: 'acct-1',
      resourceId: 'c1',
      payload: {},
    });
    const results = await Promise.all([p1.relayOnce(), p2.relayOnce()]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(published).toEqual(['container.destroyed:c1']);
  });

  it('T-CC-B10（阻断项 4a）: markExited/markFailed 仅在 CAS 命中时投递 destroyed', async () => {
    const destroyed: CloudContainerEntity[] = [];
    const { repo, service } = setupService({
      onDestroyed: (container) => destroyed.push(container),
    });

    const exitedContainer = await service.start('idle', null, [], null, {
      billingAccountId: 'acct-3',
    });
    await service.markOnline(exitedContainer.id);
    const exited = await service.markExited(exitedContainer.id, 'Job 已回收');
    expect(exited?.status).toBe('exited');
    expect(destroyed).toHaveLength(1);
    const exitedAt = exited?.exitedAt?.getTime();

    // 重复 markExited：CAS 未命中，不得再次投递（更不得用提前时刻顶替）
    await service.markExited(exitedContainer.id, 'Job 已回收');
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]!.exitedAt?.getTime()).toBe(exitedAt);

    // 处于 destroying 的记录被陈旧扫描 markFailed：CAS 未命中 → 不提前投递
    const destroying = await service.start('idle', null, [], null, {
      billingAccountId: 'acct-4',
    });
    await service.markOnline(destroying.id);
    await repo.update(destroying.id, { status: 'destroying' }, { fromStatuses: ['online'] });
    const failed = await service.markFailed(destroying.id, '陈旧扫描');
    expect(failed?.status).toBe('destroying');
    expect(destroyed).toHaveLength(1);
  });
});
