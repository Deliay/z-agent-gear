import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('./session.js', () => ({
  sessionService: {
    notifySessionStatus: vi.fn(),
    notifySessionRemoved: vi.fn(),
    notifySessionIdled: vi.fn(),
  },
}));

import { SessionLifecycleSubscriber } from './session-lifecycle-subscriber.js';
import { sessionService } from './session.js';
import { getRedisClient } from '../middleware/redis.js';

function createMockRedis() {
  const messageHandlers: ((channel: string, message: string) => void)[] = [];
  const subscriber = {
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (channel: string, message: string) => void) => {
      if (event === 'message') messageHandlers.push(handler);
    }),
    unsubscribe: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    duplicate: vi.fn().mockReturnValue(subscriber),
    _emitMessage: (channel: string, message: string) => {
      messageHandlers.forEach((h) => h(channel, message));
    },
  };
}

describe('SessionLifecycleSubscriber', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function startSubscriber() {
    const mockRedis = createMockRedis();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    const subscriber = new SessionLifecycleSubscriber();
    subscriber.start();
    return { mockRedis, subscriber };
  }

  it('removed 状态触发 notifySessionRemoved（start/resume 失败清理 → 节点失败升级）', async () => {
    const { mockRedis } = startSubscriber();

    mockRedis._emitMessage('session:status', JSON.stringify({ sessionId: 'sess-1', status: 'removed' }));
    await new Promise((r) => setImmediate(r));

    expect(sessionService.notifySessionRemoved).toHaveBeenCalledWith('sess-1');
    expect(sessionService.notifySessionIdled).not.toHaveBeenCalled();
  });

  it('idling + promptCompleted 触发 notifySessionIdled（turn 结束停滞检测）', async () => {
    const { mockRedis } = startSubscriber();

    mockRedis._emitMessage('session:status', JSON.stringify({ sessionId: 'sess-1', status: 'idling', promptCompleted: true }));
    await new Promise((r) => setImmediate(r));

    expect(sessionService.notifySessionIdled).toHaveBeenCalledWith('sess-1');
    expect(sessionService.notifySessionRemoved).not.toHaveBeenCalled();
  });

  it('裸 idling（start 落库，无 promptCompleted）不触发任何通知', async () => {
    const { mockRedis } = startSubscriber();

    mockRedis._emitMessage('session:status', JSON.stringify({ sessionId: 'sess-1', status: 'idling' }));
    await new Promise((r) => setImmediate(r));

    expect(sessionService.notifySessionIdled).not.toHaveBeenCalled();
    expect(sessionService.notifySessionRemoved).not.toHaveBeenCalled();
  });

  it('非法 JSON / 缺字段消息被忽略', async () => {
    const { mockRedis } = startSubscriber();

    mockRedis._emitMessage('session:status', 'not-json');
    mockRedis._emitMessage('session:status', JSON.stringify({ status: 'removed' }));
    await new Promise((r) => setImmediate(r));

    expect(sessionService.notifySessionIdled).not.toHaveBeenCalled();
    expect(sessionService.notifySessionRemoved).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 通用状态通道（T-SES2/T-SES3）：先于 handled 过滤透传全量事件
// ---------------------------------------------------------------------------

describe('SessionLifecycleSubscriber 通用状态通道', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function startSubscriber() {
    const mockRedis = createMockRedis();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    const subscriber = new SessionLifecycleSubscriber();
    subscriber.start();
    return { mockRedis, subscriber };
  }

  it('T-SES2: 裸 idling → notifySessionStatus 被调用、notifySessionIdled 不被调用', async () => {
    const { mockRedis } = startSubscriber();

    mockRedis._emitMessage('session:status', JSON.stringify({ sessionId: 'sess-1', status: 'idling' }));
    await new Promise((r) => setImmediate(r));

    expect(sessionService.notifySessionStatus).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      status: 'idling',
      promptCompleted: undefined,
      error: undefined,
    });
    expect(sessionService.notifySessionIdled).not.toHaveBeenCalled();
    expect(sessionService.notifySessionRemoved).not.toHaveBeenCalled();
  });

  it('T-SES3: removed / idling+promptCompleted 既有口径不变，error 字段透传', async () => {
    const { mockRedis } = startSubscriber();

    mockRedis._emitMessage('session:status', JSON.stringify({ sessionId: 'sess-1', status: 'removed', error: 'ACP_RESUME_FAILED' }));
    mockRedis._emitMessage('session:status', JSON.stringify({ sessionId: 'sess-2', status: 'idling', promptCompleted: true }));
    await new Promise((r) => setImmediate(r));

    expect(sessionService.notifySessionStatus).toHaveBeenNthCalledWith(1, {
      sessionId: 'sess-1',
      status: 'removed',
      promptCompleted: undefined,
      error: 'ACP_RESUME_FAILED',
    });
    expect(sessionService.notifySessionStatus).toHaveBeenNthCalledWith(2, {
      sessionId: 'sess-2',
      status: 'idling',
      promptCompleted: true,
      error: undefined,
    });
    expect(sessionService.notifySessionRemoved).toHaveBeenCalledWith('sess-1');
    expect(sessionService.notifySessionIdled).toHaveBeenCalledWith('sess-2');
  });

  it('T-SES3b: connecting / ended 等未处理状态仅走通用通道', async () => {
    const { mockRedis } = startSubscriber();

    mockRedis._emitMessage('session:status', JSON.stringify({ sessionId: 'sess-1', status: 'connecting' }));
    mockRedis._emitMessage('session:status', JSON.stringify({ sessionId: 'sess-1', status: 'ended', error: 'CONTROLLER_OFFLINE' }));
    await new Promise((r) => setImmediate(r));

    expect(vi.mocked(sessionService.notifySessionStatus).mock.calls.map((call) => (call[0] as { status: string }).status)).toEqual([
      'connecting',
      'ended',
    ]);
    expect(sessionService.notifySessionIdled).not.toHaveBeenCalled();
    expect(sessionService.notifySessionRemoved).not.toHaveBeenCalled();
  });
});
