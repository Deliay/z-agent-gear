import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSubscriber = {
  subscribe: vi.fn().mockResolvedValue(undefined),
  unsubscribe: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  disconnect: vi.fn(),
};
const mockRedis = { duplicate: vi.fn(() => mockSubscriber) };

vi.mock('../../middleware/redis.js', () => ({
  getRedisClient: () => mockRedis,
}));

vi.mock('../../models/workflow-instance.js', () => ({
  WorkflowInstance: { findOne: vi.fn() },
}));

vi.mock('./pr-handler-registry.js', () => ({
  prHandlerRegistry: { findByNode: vi.fn() },
}));

vi.mock('./pr-check-run-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pr-check-run-sync.js')>();
  return {
    ...actual,
    captureSnapshot: vi.fn(),
    syncTodoPanel: vi.fn(),
  };
});

import { PrCheckRunSubscriber } from './pr-check-run-subscriber.js';
import { WorkflowInstance } from '../../models/workflow-instance.js';
import { prHandlerRegistry } from './pr-handler-registry.js';
import { captureSnapshot, syncTodoPanel, type PrSyncSnapshot } from './pr-check-run-sync.js';

const SESSION_ID = 'sess-1';
const planPayload = (entries: unknown[]) =>
  JSON.stringify({
    sessionId: SESSION_ID,
    message: {
      type: 'plan',
      content: { sessionUpdate: 'plan', entries },
    },
  });

const entries = [{ content: '任务一', status: 'in_progress', priority: 'high' }];

function instance(sessionId = SESSION_ID) {
  return {
    _id: { toString: () => 'inst-1' },
    name: '需求工作流',
    nodes: [
      {
        nodeId: 'n1',
        name: '代码实现',
        status: 'RUNNING',
        stage: '实现阶段',
        sessionId: { toString: () => sessionId },
      },
    ],
  };
}

const snapshot = { handlerId: 'h1', lastCheckRunId: 1001 } as PrSyncSnapshot;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(WorkflowInstance.findOne).mockResolvedValue(instance() as never);
  vi.mocked(prHandlerRegistry.findByNode).mockResolvedValue({ _id: 'h1' } as never);
  vi.mocked(captureSnapshot).mockReturnValue(snapshot);
  vi.mocked(syncTodoPanel).mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('PrCheckRunSubscriber.handleMessage', () => {
  it('非 plan 消息直接忽略（不查库）', async () => {
    const subscriber = new PrCheckRunSubscriber();
    await subscriber.handleMessage(
      JSON.stringify({ sessionId: SESSION_ID, message: { type: 'text', content: 'hi' } }),
    );

    expect(WorkflowInstance.findOne).not.toHaveBeenCalled();
    expect(syncTodoPanel).not.toHaveBeenCalled();
  });

  it('非法 plan 载荷丢弃（不查库）', async () => {
    const subscriber = new PrCheckRunSubscriber();
    await subscriber.handleMessage(
      JSON.stringify({ sessionId: SESSION_ID, message: { type: 'plan', content: 'not-json' } }),
    );

    expect(WorkflowInstance.findOne).not.toHaveBeenCalled();
    expect(syncTodoPanel).not.toHaveBeenCalled();
  });

  it('条件 2 不满足：会话不属于工作流实例 → 零写入', async () => {
    vi.mocked(WorkflowInstance.findOne).mockResolvedValue(null);
    const subscriber = new PrCheckRunSubscriber();

    await subscriber.handleMessage(planPayload(entries));

    expect(prHandlerRegistry.findByNode).not.toHaveBeenCalled();
    expect(syncTodoPanel).not.toHaveBeenCalled();
  });

  it('条件 2 不满足：实例内无匹配 sessionId 节点 → 零写入', async () => {
    vi.mocked(WorkflowInstance.findOne).mockResolvedValue(instance('other-session') as never);
    const subscriber = new PrCheckRunSubscriber();

    await subscriber.handleMessage(planPayload(entries));

    expect(prHandlerRegistry.findByNode).not.toHaveBeenCalled();
    expect(syncTodoPanel).not.toHaveBeenCalled();
  });

  it('条件 3 不满足：节点未绑定 PR → 零写入', async () => {
    vi.mocked(prHandlerRegistry.findByNode).mockResolvedValue(null);
    const subscriber = new PrCheckRunSubscriber();

    await subscriber.handleMessage(planPayload(entries));

    expect(syncTodoPanel).not.toHaveBeenCalled();
  });

  it('条件 4 不满足：当前提交未写入 check-run → 零写入', async () => {
    vi.mocked(captureSnapshot).mockReturnValue({ handlerId: 'h1', lastCheckRunId: null } as PrSyncSnapshot);
    const subscriber = new PrCheckRunSubscriber();

    await subscriber.handleMessage(planPayload(entries));

    expect(syncTodoPanel).not.toHaveBeenCalled();
  });

  it('四条件满足 → 解析 entries 并调用 syncTodoPanel', async () => {
    const subscriber = new PrCheckRunSubscriber();

    await subscriber.handleMessage(planPayload(entries));

    expect(WorkflowInstance.findOne).toHaveBeenCalledWith({
      'nodes.sessionId': SESSION_ID,
      deletedAt: null,
    });
    expect(prHandlerRegistry.findByNode).toHaveBeenCalledWith('inst-1', 'n1');
    expect(syncTodoPanel).toHaveBeenCalledWith(snapshot, [
      { content: '任务一', status: 'in_progress', priority: 'high' },
    ]);
  });

  it('start 可重复调用不重复订阅', () => {
    const subscriber = new PrCheckRunSubscriber();
    subscriber.start();
    subscriber.start();

    expect(mockRedis.duplicate).toHaveBeenCalledTimes(1);
    expect(mockSubscriber.subscribe).toHaveBeenCalledWith('session:message');
  });
});
