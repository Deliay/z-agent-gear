import { describe, it, expect } from 'vitest';
import { ContainerService } from './container-service.js';
import { InMemoryK8sClient } from './k8s-client.js';
import { K8sJobManager } from './k8s-job-manager.js';
import { TokenService } from './token-service.js';
import { WorkloadDispatcher, truncateLogTail } from './workload-dispatcher.js';
import type { CloudContainerStatus, WorkloadPlanEntry } from '../models/cloud-container.js';
import { InMemoryContainerRepository } from '../repositories/container-repository.js';
import { InMemoryWorkloadRepository } from '../repositories/workload-repository.js';
import { InMemoryWorkloadLogRepository } from '../repositories/workload-log-repository.js';
import type { CloudWorkloadEntity } from '../repositories/workload-repository.js';

const INIT_TIMEOUT_MS = 1000;
// 起始时钟取真实当前时间：内存日志仓储以 Date.now() 记录 createdAt，避免注入时钟早于
// 记录时间导致「停留时长」为负。
const NOW_BASE = Date.now();

function mkWorkload(
  id: string,
  name: string,
  opts: { initScript?: string | null; postScript?: string | null } = {},
): CloudWorkloadEntity {
  return {
    id,
    name,
    initScript: opts.initScript ?? null,
    postScript: opts.postScript ?? null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function waitForCondition(predicate: () => boolean, timeout = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('condition not met in time'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

interface RunPayload {
  phase: 'init' | 'post';
  items: Array<{
    logId: string;
    workloadId?: string;
    workloadName: string;
    script: string;
    params?: Record<string, unknown>;
    timeoutMs: number;
  }>;
  budgetMs?: number;
}

function setup(options: { postBudgetMs?: number; logMaxBytes?: number; connected?: boolean } = {}) {
  const repo = new InMemoryContainerRepository();
  const tokenService = new TokenService(repo);
  const jobManager = new K8sJobManager(new InMemoryK8sClient(), {
    namespace: 'zag-workers',
    image: 'zero-tools/zag-worker:latest',
    publicWsEndpoint: 'cloud.example.com:4003',
  });
  const containerService = new ContainerService(repo, tokenService, jobManager, {
    namespace: 'zag-workers',
    image: 'zero-tools/zag-worker:latest',
    connectTimeoutMs: 300000,
    shutdownGraceMs: 0,
  });
  const workloadRepository = new InMemoryWorkloadRepository();
  const workloadLogRepository = new InMemoryWorkloadLogRepository();
  const emitted: Array<{ containerId: string; event: string; payload: RunPayload }> = [];
  const warnings: unknown[][] = [];
  const connection = { connected: options.connected ?? true };
  let nowMs = NOW_BASE;

  const dispatcher = new WorkloadDispatcher({
    containerRepository: repo,
    containerService,
    workloadRepository,
    workloadLogRepository,
    emitToContainer: (containerId, event, payload) =>
      emitted.push({ containerId, event, payload: payload as RunPayload }),
    isConnected: () => connection.connected,
    initTimeoutMs: INIT_TIMEOUT_MS,
    postBudgetMs: options.postBudgetMs ?? 5000,
    logMaxBytes: options.logMaxBytes ?? 64,
    now: () => nowMs,
    logger: {
      info: () => {},
      warn: (...args: unknown[]) => warnings.push(args),
      error: () => {},
    },
  });

  const createContainer = async (
    workloadIds: string[],
    status: CloudContainerStatus = 'connecting',
    workloadPlan: WorkloadPlanEntry[] = [],
  ) =>
    repo.create({
      name: `zag-worker-${Math.random().toString(36).slice(2, 8)}`,
      namespace: 'zag-workers',
      purpose: 'idle',
      image: 'zero-tools/zag-worker:latest',
      status,
      workloadIds,
      workloadPlan,
      connectedAt: status === 'online' ? new Date(NOW_BASE) : null,
    });

  const runs = (phase: 'init' | 'post') =>
    emitted.filter((entry) => entry.event === 'workload:run' && entry.payload.phase === phase);

  return {
    repo,
    containerService,
    workloadRepository,
    workloadLogRepository,
    dispatcher,
    emitted,
    warnings,
    connection,
    createContainer,
    runs,
    setNow: (value: number) => {
      nowMs = value;
    },
    advanceTime: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
  };
}

describe('WorkloadDispatcher - init 批次', () => {
  it('T-WD1: 只下发带 initScript 的工作负载，按选择顺序创建日志并置 initializing', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, repo, runs } =
      setup();
    workloadRepository.add(mkWorkload('w1', 'init-a', { initScript: 'echo a' }));
    workloadRepository.add(mkWorkload('w2', 'no-init', {}));
    workloadRepository.add(mkWorkload('w3', 'init-b', { initScript: 'echo b' }));
    const container = await createContainer(['w1', 'w2', 'w3']);

    const started = await dispatcher.startInit(container.id);

    expect(started).toBe(true);
    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs.map((log) => log.workloadId)).toEqual(['w1', 'w3']);
    expect(logs[0]!.status).toBe('running');
    expect(logs[0]!.script).toBe('echo a');
    expect(logs[0]!.startedAt).toBeInstanceOf(Date);
    expect(logs[1]!.status).toBe('pending');

    expect(runs('init')).toHaveLength(1);
    const payload = runs('init')[0]!.payload;
    expect(payload.items.map((item) => item.workloadName)).toEqual(['init-a', 'init-b']);
    expect(payload.items[0]!.logId).toBe(logs[0]!.id);
    expect(payload.items[0]!.timeoutMs).toBe(INIT_TIMEOUT_MS);
    expect(payload.budgetMs).toBeUndefined();

    const stored = await repo.findById(container.id);
    expect(stored?.status).toBe('initializing');
    expect(stored?.currentWorkloadName).toBe('init-a');
  });

  it('T-WD2: 逐条结果推进并在全部终态后 online（清空 currentWorkloadName）', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, repo } = setup();
    workloadRepository.add(mkWorkload('w1', 'init-a', { initScript: 'echo a' }));
    workloadRepository.add(mkWorkload('w2', 'init-b', { initScript: 'echo b' }));
    const container = await createContainer(['w1', 'w2']);
    await dispatcher.startInit(container.id);
    let logs = await workloadLogRepository.findByContainer(container.id);

    await dispatcher.handleResult(container.id, {
      logId: logs[0]!.id,
      status: 'success',
      exitCode: 0,
      log: 'a-output',
    });

    logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs[0]!.status).toBe('success');
    expect(logs[0]!.exitCode).toBe(0);
    expect(logs[0]!.finishedAt).toBeInstanceOf(Date);
    expect(logs[1]!.status).toBe('running');
    expect((await repo.findById(container.id))?.currentWorkloadName).toBe('init-b');

    await dispatcher.handleResult(container.id, { logId: logs[1]!.id, status: 'success' });

    const stored = await repo.findById(container.id);
    expect(stored?.status).toBe('online');
    expect(stored?.currentWorkloadName).toBeNull();
    expect((await workloadLogRepository.findByContainer(container.id)).every((log) => log.status === 'success')).toBe(true);
  });

  it('T-WD3: failed/timeout 结果不阻断后续条目，最终仍 online', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, repo } = setup();
    workloadRepository.add(mkWorkload('w1', 'init-a', { initScript: 'exit 1' }));
    workloadRepository.add(mkWorkload('w2', 'init-b', { initScript: 'sleep 1' }));
    const container = await createContainer(['w1', 'w2']);
    await dispatcher.startInit(container.id);
    let logs = await workloadLogRepository.findByContainer(container.id);

    await dispatcher.handleResult(container.id, { logId: logs[0]!.id, status: 'failed', exitCode: 1 });
    logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs[1]!.status).toBe('running');

    await dispatcher.handleResult(container.id, { logId: logs[1]!.id, status: 'timeout' });

    expect((await repo.findById(container.id))?.status).toBe('online');
    const final = await workloadLogRepository.findByContainer(container.id);
    expect(final.map((log) => log.status)).toEqual(['failed', 'timeout']);
  });

  it('T-WD4: 已删除工作负载生成 FAILED 占位记录且不阻断后续', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, repo, runs } =
      setup();
    workloadRepository.add(mkWorkload('w2', 'init-b', { initScript: 'echo b' }));
    const container = await createContainer(['missing', 'w2']);

    const started = await dispatcher.startInit(container.id);

    expect(started).toBe(true);
    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs[0]!.workloadId).toBe('missing');
    expect(logs[0]!.status).toBe('failed');
    expect(logs[0]!.script).toBe('');
    expect(logs[0]!.log).toContain('已删除');
    expect(logs[0]!.finishedAt).toBeInstanceOf(Date);
    expect(logs[1]!.status).toBe('running');

    expect(runs('init')[0]!.payload.items).toHaveLength(1);
    expect((await repo.findById(container.id))?.status).toBe('initializing');
    await dispatcher.handleResult(container.id, { logId: logs[1]!.id, status: 'success' });
    expect((await repo.findById(container.id))?.status).toBe('online');
  });

  it('T-WD4b: 全部工作负载已删除时不进入 initializing（仅留档）', async () => {
    const { dispatcher, workloadLogRepository, createContainer, repo, runs } = setup();
    const container = await createContainer(['missing']);

    const started = await dispatcher.startInit(container.id);

    expect(started).toBe(false);
    expect(runs('init')).toHaveLength(0);
    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe('failed');
    expect((await repo.findById(container.id))?.status).toBe('connecting');
  });
});

describe('WorkloadDispatcher - 结果幂等与串号', () => {
  it('T-WD5: 终态记录忽略重复结果；logId 不属于该容器则拒绝并告警', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, warnings } =
      setup();
    workloadRepository.add(mkWorkload('w1', 'init-a', { initScript: 'echo a' }));
    workloadRepository.add(mkWorkload('w2', 'init-b', { initScript: 'echo b' }));
    const first = await createContainer(['w1']);
    const second = await createContainer(['w2']);
    await dispatcher.startInit(first.id);
    await dispatcher.startInit(second.id);
    const firstLog = (await workloadLogRepository.findByContainer(first.id))[0]!;

    await dispatcher.handleResult(first.id, { logId: firstLog.id, status: 'success', log: 'first' });
    // 重复结果（迟到/重放）应被幂等忽略，不覆盖已写入的内容
    await dispatcher.handleResult(first.id, { logId: firstLog.id, status: 'failed', log: 'second' });
    const afterDuplicate = (await workloadLogRepository.findById(firstLog.id))!;
    expect(afterDuplicate.status).toBe('success');
    expect(afterDuplicate.log).toBe('first');

    // 串号：second 容器上报 first 容器的 logId → 拒绝且不改写
    const secondLog = (await workloadLogRepository.findByContainer(second.id))[0]!;
    await dispatcher.handleResult(second.id, { logId: firstLog.id, status: 'failed' });
    expect((await workloadLogRepository.findById(secondLog.id))?.status).toBe('running');
    expect(warnings.length).toBeGreaterThan(0);

    // 未知 logId 不崩溃
    await dispatcher.handleResult(first.id, { logId: 'does-not-exist', status: 'success' });
    // 缺少 logId 也不崩溃（记录告警）
    await dispatcher.handleResult(first.id, { status: 'success' });
  });

  it('T-WD5b: 结果日志按 WORKLOAD_LOG_MAX_BYTES 尾部截断', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer } = setup({
      logMaxBytes: 8,
    });
    workloadRepository.add(mkWorkload('w1', 'init-a', { initScript: 'echo a' }));
    const container = await createContainer(['w1']);
    await dispatcher.startInit(container.id);
    const log = (await workloadLogRepository.findByContainer(container.id))[0]!;

    await dispatcher.handleResult(container.id, {
      logId: log.id,
      status: 'success',
      log: '0123456789ABCDEF',
    });

    const stored = (await workloadLogRepository.findById(log.id))!;
    expect(Buffer.byteLength(stored.log, 'utf8')).toBeLessThanOrEqual(8);
    expect(stored.log).toBe('89ABCDEF');
  });
});

describe('WorkloadDispatcher - 掉线与看门狗', () => {
  it('T-WD6: 旧 worker 不响应 → 看门狗标 TIMEOUT 并推进，最终 online', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, repo, advanceTime } =
      setup();
    workloadRepository.add(mkWorkload('w1', 'init-a', { initScript: 'echo a' }));
    workloadRepository.add(mkWorkload('w2', 'init-b', { initScript: 'echo b' }));
    const container = await createContainer(['w1', 'w2']);
    await dispatcher.startInit(container.id);

    advanceTime(INIT_TIMEOUT_MS + 30001);
    await dispatcher.onWatchdog();

    let logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs[0]!.status).toBe('timeout');
    expect(logs[1]!.status).toBe('running');
    expect((await repo.findById(container.id))?.currentWorkloadName).toBe('init-b');

    advanceTime(INIT_TIMEOUT_MS + 30001);
    await dispatcher.onWatchdog();

    logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs[1]!.status).toBe('timeout');
    expect((await repo.findById(container.id))?.status).toBe('online');
  });

  it('T-WD10: 全部 init 结束但无活跃 socket → connecting', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, repo, connection } =
      setup();
    workloadRepository.add(mkWorkload('w1', 'init-a', { initScript: 'echo a' }));
    const container = await createContainer(['w1']);
    await dispatcher.startInit(container.id);
    const log = (await workloadLogRepository.findByContainer(container.id))[0]!;

    connection.connected = false;
    await dispatcher.handleResult(container.id, { logId: log.id, status: 'success' });

    const stored = await repo.findById(container.id);
    expect(stored?.status).toBe('connecting');
    expect(stored?.currentWorkloadName).toBeNull();
  });

  it('T-WD11: 无 RUNNING 但 PENDING 停留超过 60s → 推进为 RUNNING', async () => {
    const { dispatcher, workloadLogRepository, createContainer, repo, advanceTime, workloadRepository } =
      setup();
    workloadRepository.add(mkWorkload('w2', 'init-b', { initScript: 'echo b' }));
    const container = await createContainer([]);
    await repo.update(container.id, { status: 'initializing', currentWorkloadName: null });
    await workloadLogRepository.createMany([
      {
        containerId: container.id,
        workloadId: 'w2',
        workloadName: 'init-b',
        phase: 'init',
        status: 'pending',
        script: 'echo b',
      },
    ]);

    advanceTime(61000);
    await dispatcher.onWatchdog();

    const log = (await workloadLogRepository.findByContainer(container.id))[0]!;
    expect(log.status).toBe('running');
    expect((await repo.findById(container.id))?.currentWorkloadName).toBe('init-b');
  });

  it('T-WD12: initializing 停留超过 items×initTimeoutMs+120s → 剩余全部 TIMEOUT 并收口', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, repo, advanceTime } =
      setup();
    workloadRepository.add(mkWorkload('w1', 'init-a', { initScript: 'echo a' }));
    workloadRepository.add(mkWorkload('w2', 'init-b', { initScript: 'echo b' }));
    const container = await createContainer(['w1', 'w2']);
    await dispatcher.startInit(container.id);

    advanceTime(2 * INIT_TIMEOUT_MS + 120000 + 1);
    await dispatcher.onWatchdog();
    await dispatcher.onWatchdog();

    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs.map((log) => log.status)).toEqual(['timeout', 'timeout']);
    expect((await repo.findById(container.id))?.status).toBe('online');
  });

  it('T-WD14: initializing 但无活跃 init 记录 → 看门狗直接收口', async () => {
    const { dispatcher, workloadLogRepository, createContainer, repo } = setup();
    const container = await createContainer([], 'initializing');
    await workloadLogRepository.createMany([
      {
        containerId: container.id,
        workloadId: 'w1',
        workloadName: 'x',
        phase: 'init',
        status: 'success',
        script: '',
        finishedAt: new Date(),
      },
    ]);

    await dispatcher.onWatchdog();

    expect((await repo.findById(container.id))?.status).toBe('online');
  });
});

describe('WorkloadDispatcher - post 批次', () => {
  it('T-WD7: 无活跃 socket 的 destroy → post 记录直接 TIMEOUT 且不 emit', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, runs } = setup({
      connected: false,
    });
    workloadRepository.add(mkWorkload('w1', 'clean-a', { postScript: 'rm -rf /tmp/a' }));
    const container = await createContainer(['w1'], 'destroying');

    await dispatcher.runPostBatch(container.id);

    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.phase).toBe('post');
    expect(logs[0]!.status).toBe('timeout');
    expect(logs[0]!.log).toContain('未连接');
    expect(logs[0]!.script).toBe('rm -rf /tmp/a');
    expect(runs('post')).toHaveLength(0);
  });

  it('T-WD7b: post 阶段已删除工作负载生成 FAILED 占位记录（未执行清理）', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, runs } = setup({
      connected: false,
    });
    workloadRepository.add(mkWorkload('w1', 'clean-a', { postScript: 'rm -rf /tmp/a' }));
    const container = await createContainer(['w1', 'missing'], 'destroying');

    await dispatcher.runPostBatch(container.id);

    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs).toHaveLength(2);
    const deleted = logs.find((log) => log.workloadId === 'missing')!;
    expect(deleted.phase).toBe('post');
    expect(deleted.status).toBe('failed');
    expect(deleted.script).toBe('');
    expect(deleted.log).toContain('已删除');
    expect(deleted.log).toContain('未执行清理');
    // 无连接 → 有 post 脚本的项如实标 timeout
    expect(logs.find((log) => log.workloadId === 'w1')!.status).toBe('timeout');
    expect(runs('post')).toHaveLength(0);
  });

  it('T-WD7c: post 阶段全部工作负载已删除时仅留档、不下发批次', async () => {
    const { dispatcher, workloadLogRepository, createContainer, runs } = setup();
    const container = await createContainer(['missing-a', 'missing-b'], 'destroying');

    await dispatcher.runPostBatch(container.id);

    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs).toHaveLength(2);
    expect(logs.every((log) => log.status === 'failed')).toBe(true);
    expect(logs.every((log) => log.log.includes('未执行清理'))).toBe(true);
    expect(runs('post')).toHaveLength(0);
  });

  it('T-WD8: 有 post 脚本的 destroy → emit 批次并等待结果', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, runs } = setup();
    workloadRepository.add(mkWorkload('w1', 'clean-a', { postScript: 'echo bye' }));
    const container = await createContainer(['w1'], 'destroying');

    const done = dispatcher.runPostBatch(container.id);
    await waitForCondition(() => runs('post').length === 1);

    const payload = runs('post')[0]!.payload;
    expect(payload.budgetMs).toBe(5000);
    expect(payload.items[0]!.workloadName).toBe('clean-a');
    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs[0]!.status).toBe('running');

    await dispatcher.handleResult(container.id, {
      logId: payload.items[0]!.logId,
      status: 'success',
      exitCode: 0,
      log: 'bye',
    });
    await done;

    expect((await workloadLogRepository.findById(logs[0]!.id))?.status).toBe('success');
  });

  it('T-WD8c: 已删除项留档但不进入下发批次，结果收口后 runPostBatch 立即返回', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, runs } = setup({
      postBudgetMs: 60000,
    });
    workloadRepository.add(mkWorkload('w1', 'clean-a', { postScript: 'echo bye' }));
    const container = await createContainer(['w1', 'missing'], 'destroying');

    const done = dispatcher.runPostBatch(container.id);
    await waitForCondition(() => runs('post').length === 1);

    const items = runs('post')[0]!.payload.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.workloadName).toBe('clean-a');

    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs.find((log) => log.workloadId === 'missing')!.log).toContain('未执行清理');

    await dispatcher.handleResult(container.id, { logId: items[0]!.logId, status: 'success' });
    const start = Date.now();
    await done;
    expect(Date.now() - start).toBeLessThan(1000);
    expect((await workloadLogRepository.findById(items[0]!.logId))?.status).toBe('success');
  });

  it('T-WD8b: post 预算耗尽 → 剩余记录标 TIMEOUT', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer } = setup({
      postBudgetMs: 30,
    });
    workloadRepository.add(mkWorkload('w1', 'clean-a', { postScript: 'sleep 999' }));
    const container = await createContainer(['w1'], 'destroying');

    await dispatcher.runPostBatch(container.id);

    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs[0]!.status).toBe('timeout');
    expect(logs[0]!.log).toContain('超时');
  });

  it('T-WD9: destroy 打断 init → init 非终态标 TIMEOUT，迟到结果忽略', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, runs } = setup();
    workloadRepository.add(
      mkWorkload('w1', 'both', { initScript: 'echo init', postScript: 'echo post' }),
    );
    workloadRepository.add(mkWorkload('w2', 'init-b', { initScript: 'echo b' }));
    const container = await createContainer(['w1', 'w2']);
    await dispatcher.startInit(container.id);
    const initLogs = await workloadLogRepository.findByContainer(container.id);
    expect(initLogs).toHaveLength(2);

    const done = dispatcher.runPostBatch(container.id);
    await waitForCondition(() => runs('post').length === 1);

    const afterInterrupt = await workloadLogRepository.findByContainer(container.id);
    const initAfter = afterInterrupt.filter((log) => log.phase === 'init');
    expect(initAfter.map((log) => log.status)).toEqual(['timeout', 'timeout']);
    expect(initAfter[0]!.log).toContain('销毁中断');

    // 迟到的 init 结果按终态幂等忽略
    await dispatcher.handleResult(container.id, { logId: initLogs[0]!.id, status: 'success' });
    expect((await workloadLogRepository.findById(initLogs[0]!.id))?.status).toBe('timeout');

    const postPayload = runs('post')[0]!.payload;
    await dispatcher.handleResult(container.id, {
      logId: postPayload.items[0]!.logId,
      status: 'success',
    });
    await done;
    const postLog = (await workloadLogRepository.findByContainer(container.id)).find(
      (log) => log.phase === 'post',
    )!;
    expect(postLog.status).toBe('success');
  });

  it('T-WD9b: init 进行中不开 post 时（无 post 脚本）runPostBatch 立即返回并保留 init TIMEOUT', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, runs } = setup();
    workloadRepository.add(mkWorkload('w1', 'init-only', { initScript: 'echo init' }));
    const container = await createContainer(['w1']);
    await dispatcher.startInit(container.id);

    await dispatcher.runPostBatch(container.id);

    expect(runs('post')).toHaveLength(0);
    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs[0]!.status).toBe('timeout');
    expect(logs[0]!.log).toContain('销毁中断');
  });

  it('hasPostScripts 反映挂载的 postScript', async () => {
    const { dispatcher, workloadRepository, createContainer } = setup();
    workloadRepository.add(mkWorkload('w1', 'with-post', { initScript: 'echo a', postScript: 'echo b' }));
    workloadRepository.add(mkWorkload('w2', 'no-post', { initScript: 'echo c' }));
    const withPost = await createContainer(['w1']);
    const withoutPost = await createContainer(['w2']);

    expect(await dispatcher.hasPostScripts(withPost.id)).toBe(true);
    expect(await dispatcher.hasPostScripts(withoutPost.id)).toBe(false);
  });
});

describe('WorkloadDispatcher - 重连不重发', () => {
  it('T-WD13: 已是 initializing 的重连不重发批次', async () => {
    const { dispatcher, workloadRepository, createContainer, runs } = setup();
    workloadRepository.add(mkWorkload('w1', 'init-a', { initScript: 'echo a' }));
    const container = await createContainer(['w1']);
    await dispatcher.startInit(container.id);
    expect(runs('init')).toHaveLength(1);

    const started = await dispatcher.startInit(container.id);

    expect(started).toBe(true);
    expect(runs('init')).toHaveLength(1);
  });

  it('T-WD15: 非法结果状态回落 failed；看门狗在已有日志后追加说明', async () => {
    const { dispatcher, workloadLogRepository, createContainer, advanceTime } = setup();
    const bad = await createContainer(['x'], 'initializing');
    await workloadLogRepository.createMany([
      {
        containerId: bad.id,
        workloadId: 'x',
        workloadName: 'x',
        phase: 'init',
        status: 'running',
        script: 's',
        log: 'partial',
        startedAt: new Date(),
      },
    ]);
    const badLog = (await workloadLogRepository.findByContainer(bad.id))[0]!;
    await dispatcher.handleResult(bad.id, { logId: badLog.id, status: 'weird' });
    expect((await workloadLogRepository.findById(badLog.id))?.status).toBe('failed');

    const stuck = await createContainer(['y'], 'initializing');
    await workloadLogRepository.createMany([
      {
        containerId: stuck.id,
        workloadId: 'y',
        workloadName: 'y',
        phase: 'init',
        status: 'running',
        script: 's',
        log: 'partial',
        startedAt: new Date(),
      },
    ]);
    advanceTime(INIT_TIMEOUT_MS + 31000);
    await dispatcher.onWatchdog();
    const stuckLog = (await workloadLogRepository.findByContainer(stuck.id))[0]!;
    expect(stuckLog.status).toBe('timeout');
    expect(stuckLog.log).toContain('partial');
  });

  it('hasInitScripts 反映状态与挂载脚本', async () => {
    const { dispatcher, workloadRepository, createContainer } = setup();
    workloadRepository.add(mkWorkload('w1', 'with-init', { initScript: 'echo a' }));
    workloadRepository.add(mkWorkload('w2', 'no-init', { postScript: 'echo b' }));

    expect(await dispatcher.hasInitScripts('missing-container')).toBe(false);
    const withInit = await createContainer(['w1']);
    expect(await dispatcher.hasInitScripts(withInit.id)).toBe(true);
    const withoutInit = await createContainer(['w2']);
    expect(await dispatcher.hasInitScripts(withoutInit.id)).toBe(false);
    const online = await createContainer(['w1'], 'online');
    expect(await dispatcher.hasInitScripts(online.id)).toBe(false);
    // 已删除项仍需走初始化流程以生成 FAILED 留档记录（裁决 3）。
    const deletedOnly = await createContainer(['definitely-missing']);
    expect(await dispatcher.hasInitScripts(deletedOnly.id)).toBe(true);
  });

  it('truncateLogTail 保留尾部且不产生半个多字节字符', () => {
    expect(truncateLogTail('abcdef', 3)).toBe('def');
    expect(truncateLogTail('abc', 10)).toBe('abc');
    expect(truncateLogTail('', 10)).toBe('');
    expect(truncateLogTail('中文内容', 5)).toBe('容');
  });
});

describe('WorkloadDispatcher - 执行计划与参数（workloadPlan/params）', () => {
  it('T-WD11: init 按 plan 下发，items 携带 workloadId/params，日志写入 params 快照', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, runs } = setup();
    workloadRepository.add(mkWorkload('w1', 'init-a', { initScript: 'echo a' }));
    workloadRepository.add(mkWorkload('w2', 'init-b', { initScript: 'echo b' }));
    const container = await createContainer(['w1', 'w2'], 'connecting', [
      { workloadId: 'w1', params: { version: '22', pm: ['pnpm'] }, implicit: false },
      { workloadId: 'w2', params: {}, implicit: true },
    ]);

    const started = await dispatcher.startInit(container.id);

    expect(started).toBe(true);
    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs.map((log) => log.workloadId)).toEqual(['w1', 'w2']);
    expect(logs[0]!.params).toEqual({ version: '22', pm: ['pnpm'] });
    expect(logs[1]!.params).toEqual({});

    const items = runs('init')[0]!.payload.items;
    expect(items.map((item) => item.workloadId)).toEqual(['w1', 'w2']);
    expect(items[0]!.params).toEqual({ version: '22', pm: ['pnpm'] });
    expect(items[1]!.params).toEqual({});
  });

  it('T-WD12: 隐式依赖按 plan 顺序下发，隐式条目参数为默认值快照', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, runs } = setup();
    workloadRepository.add(mkWorkload('dep', 'base', { initScript: 'echo dep' }));
    workloadRepository.add(mkWorkload('app', 'app', { initScript: 'echo app' }));
    const container = await createContainer(['dep', 'app'], 'connecting', [
      { workloadId: 'dep', params: { version: '22' }, implicit: true },
      { workloadId: 'app', params: { pm: ['npm'] }, implicit: false },
    ]);

    await dispatcher.startInit(container.id);

    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs.map((log) => log.workloadId)).toEqual(['dep', 'app']);
    expect(logs.map((log) => log.params)).toEqual([{ version: '22' }, { pm: ['npm'] }]);
    expect(runs('init')[0]!.payload.items.map((item) => item.workloadId)).toEqual(['dep', 'app']);
  });

  it('T-WD13: 历史容器无 plan → 回退 workloadIds + 空 params，行为与现状一致', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, runs } = setup();
    workloadRepository.add(mkWorkload('w1', 'init-a', { initScript: 'echo a' }));
    const container = await createContainer(['w1']);

    await dispatcher.startInit(container.id);

    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs[0]!.params).toEqual({});
    const items = runs('init')[0]!.payload.items;
    expect(items[0]!.workloadId).toBe('w1');
    expect(items[0]!.params).toEqual({});
  });

  it('T-WD14: post 批次写入 params 快照；已删除占位记录 params 为 {}', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, runs } = setup();
    workloadRepository.add(mkWorkload('w1', 'clean-a', { postScript: 'echo bye' }));
    const container = await createContainer(['w1', 'missing'], 'destroying', [
      { workloadId: 'w1', params: { keep: true }, implicit: false },
      { workloadId: 'missing', params: {}, implicit: true },
    ]);

    const done = dispatcher.runPostBatch(container.id);
    await waitForCondition(() => runs('post').length === 1);

    const items = runs('post')[0]!.payload.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.workloadId).toBe('w1');
    expect(items[0]!.params).toEqual({ keep: true });

    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs.find((log) => log.workloadId === 'w1')!.params).toEqual({ keep: true });
    expect(logs.find((log) => log.workloadId === 'missing')!.params).toEqual({});

    await dispatcher.handleResult(container.id, { logId: items[0]!.logId, status: 'success' });
    await done;
  });

  it('T-WD14b: 无活跃连接时 post 未执行项也写入 params 快照', async () => {
    const { dispatcher, workloadRepository, workloadLogRepository, createContainer, runs } = setup({
      connected: false,
    });
    workloadRepository.add(mkWorkload('w1', 'clean-a', { postScript: 'rm -rf /tmp/a' }));
    const container = await createContainer(['w1'], 'destroying', [
      { workloadId: 'w1', params: { keep: true }, implicit: false },
    ]);

    await dispatcher.runPostBatch(container.id);

    expect(runs('post')).toHaveLength(0);
    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs[0]!.status).toBe('timeout');
    expect(logs[0]!.params).toEqual({ keep: true });
  });
});
