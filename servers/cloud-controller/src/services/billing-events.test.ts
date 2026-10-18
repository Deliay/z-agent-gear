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
});
