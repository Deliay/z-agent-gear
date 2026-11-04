import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../models/workflow-instance.js', () => ({
  WorkflowInstance: {
    find: vi.fn(),
  },
}));

vi.mock('./interrupt-retry.js', () => ({
  executeScheduledRetry: vi.fn().mockResolvedValue(undefined),
  scheduleInterruptionRetry: vi.fn().mockResolvedValue('scheduled'),
}));

import { InterruptRetryScheduler, INTERRUPT_RETRY_POLL_INTERVAL_MS } from './interrupt-retry-scheduler.js';
import { WorkflowInstance } from '../../models/workflow-instance.js';
import { executeScheduledRetry, scheduleInterruptionRetry } from './interrupt-retry.js';

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

function node(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: 'n1',
    status: 'RUNNING',
    sessionId: 'sess-1',
    retryPhase: 'SCHEDULED',
    retryTrigger: 'ENDED',
    nextRetryAt: new Date(Date.now() - 1_000),
    retryDeadlineAt: null,
    ...overrides,
  };
}

function instance(nodes: Record<string, unknown>[], id = 'inst-1') {
  return { _id: oid(id), nodes };
}

function stubFindOnce(rows: unknown[]) {
  vi.mocked(WorkflowInstance.find).mockImplementationOnce(
    (() => ({ limit: () => ({ lean: async () => rows }) })) as never,
  );
}

describe('InterruptRetryScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('T-SCH1: 扫描 A 执行到期计划，未到期跳过', async () => {
    stubFindOnce([
      instance([
        node({ nodeId: 'due' }),
        node({ nodeId: 'future', nextRetryAt: new Date(Date.now() + 60_000) }),
      ]),
    ]);
    stubFindOnce([]);

    await new InterruptRetryScheduler().scan();

    expect(executeScheduledRetry).toHaveBeenCalledTimes(1);
    expect(executeScheduledRetry).toHaveBeenCalledWith('inst-1', 'due');
  });

  it('T-SCH2: 扫描 B：RECONNECTING 且 deadline 过期 → 重排（带 expectedPhase）', async () => {
    stubFindOnce([]);
    stubFindOnce([
      instance([
        node({
          nodeId: 'stale',
          retryPhase: 'RECONNECTING',
          retryTrigger: 'IDLED',
          retryDeadlineAt: new Date(Date.now() - 1_000),
        }),
      ]),
    ]);

    await new InterruptRetryScheduler().scan();

    expect(scheduleInterruptionRetry).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      nodeId: 'stale',
      sessionId: 'sess-1',
      trigger: 'IDLED',
      expectedPhase: 'RECONNECTING',
    });
    expect(executeScheduledRetry).not.toHaveBeenCalled();
  });

  it('T-SCH3: 单轮不重叠（scanning 互斥）', async () => {
    let release!: () => void;
    vi.mocked(executeScheduledRetry).mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    stubFindOnce([instance([node({ nodeId: 'n1' })]), instance([node({ nodeId: 'n2' })], 'inst-2')]);
    stubFindOnce([]);

    const scheduler = new InterruptRetryScheduler();
    try {
      const first = scheduler.scan();
      const second = scheduler.scan(); // 同一轮未完成 → 直接返回
      await second;
      await vi.waitFor(() => {
        expect(executeScheduledRetry).toHaveBeenCalledTimes(1);
      });

      release();
      await first;
    } finally {
      release?.();
    }
    expect(executeScheduledRetry).toHaveBeenCalledTimes(2);
  });

  it('T-SCH3b: 单条执行异常只告警，不拖垮其余条目', async () => {
    vi.mocked(executeScheduledRetry)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    stubFindOnce([instance([node({ nodeId: 'bad' }), node({ nodeId: 'good' })])]);
    stubFindOnce([]);

    await new InterruptRetryScheduler().scan();

    expect(executeScheduledRetry).toHaveBeenCalledTimes(2);
  });

  it('T-SCH4: start() 立即扫一轮、定时周期为 30s、stop() 清理定时器', async () => {
    vi.useFakeTimers();
    stubFindOnce([]);
    stubFindOnce([]);
    const scheduler = new InterruptRetryScheduler();

    scheduler.start();
    expect(INTERRUPT_RETRY_POLL_INTERVAL_MS).toBe(30_000);
    expect(vi.getTimerCount()).toBe(1);

    stubFindOnce([]);
    stubFindOnce([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(WorkflowInstance.find).toHaveBeenCalledTimes(4); // 启动 2 次查询 + 定时 2 次查询

    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('T-SCH5: 已删除 / 节点非 RUNNING、REWORK 的条目跳过', async () => {
    stubFindOnce([
      instance([node({ nodeId: 'done', status: 'DONE' })]),
      instance([node({ nodeId: 'retry', status: 'RETRY_FAILED' })], 'inst-2'),
    ]);
    stubFindOnce([instance([node({ nodeId: 'bad', retryPhase: 'RECONNECTING', retryDeadlineAt: null })], 'inst-3')]);

    await new InterruptRetryScheduler().scan();

    expect(executeScheduledRetry).not.toHaveBeenCalled();
    expect(scheduleInterruptionRetry).not.toHaveBeenCalled();
  });
});
