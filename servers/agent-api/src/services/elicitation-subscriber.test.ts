import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('./todo-service.js', () => ({
  todoService: {
    createElicitationTodo: vi.fn(),
    markElicitationCompleted: vi.fn(),
    markElicitationResolved: vi.fn(),
  },
}));

vi.mock('./session-sse.js', () => ({
  sessionSSEService: {
    pushToUser: vi.fn(),
  },
}));

import { ElicitationSubscriberService } from './elicitation-subscriber.js';
import { getRedisClient } from '../middleware/redis.js';
import { todoService } from './todo-service.js';
import { sessionSSEService } from './session-sse.js';

type MessageHandler = (channel: string, message: string) => Promise<void>;

const mockSubscriber = {
  subscribe: vi.fn(),
  on: vi.fn(),
  unsubscribe: vi.fn(),
  quit: vi.fn(),
};

const mockRedis = {
  duplicate: vi.fn(),
};

function getMessageHandler(): MessageHandler {
  const call = mockSubscriber.on.mock.calls.find(([event]) => event === 'message');
  if (!call) throw new Error('message handler not registered');
  return call[1] as MessageHandler;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.duplicate.mockReturnValue(mockSubscriber);
  mockSubscriber.subscribe.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null) => void;
    cb(null);
  });
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
});

describe('ElicitationSubscriberService', () => {
  it('should create todo and push SSE on elicitation request', async () => {
    const todo = { _id: 'todo-1', createdAt: new Date('2026-08-07T00:00:00Z') };
    vi.mocked(todoService.createElicitationTodo).mockResolvedValue(todo as never);

    const service = new ElicitationSubscriberService();
    service.start();

    const handler = getMessageHandler();
    await handler('elicitation:request', JSON.stringify({
      requestId: 'elic-1',
      controllerId: 'ctrl-1',
      sessionId: 'sess-1',
      userId: 'user-1',
      mode: 'form',
      message: 'Which strategy?',
      requestedSchema: { type: 'object', properties: { strategy: { type: 'string' } } },
    }));

    expect(todoService.createElicitationTodo).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'elic-1',
      userId: 'user-1',
      mode: 'form',
    }));
    expect(sessionSSEService.pushToUser).toHaveBeenCalledWith('user-1', {
      type: 'elicitation_request',
      data: expect.objectContaining({
        requestId: 'elic-1',
        sessionId: 'sess-1',
        mode: 'form',
        message: 'Which strategy?',
        todoId: 'todo-1',
      }),
    });

    service.stop();
  });

  it('should mark todo completed and push SSE on elicitation complete', async () => {
    const service = new ElicitationSubscriberService();
    service.start();

    const handler = getMessageHandler();
    await handler('elicitation:complete', JSON.stringify({
      sessionId: 'sess-1',
      elicitationId: 'github-oauth-001',
      userId: 'user-1',
    }));

    expect(todoService.markElicitationCompleted).toHaveBeenCalledWith('github-oauth-001', 'user-1');
    expect(sessionSSEService.pushToUser).toHaveBeenCalledWith('user-1', {
      type: 'elicitation_complete',
      data: { elicitationId: 'github-oauth-001' },
    });

    service.stop();
  });

  it('should ignore messages from other channels', async () => {
    const service = new ElicitationSubscriberService();
    service.start();

    const handler = getMessageHandler();
    await handler('permission:request', JSON.stringify({ requestId: 'x' }));

    expect(todoService.createElicitationTodo).not.toHaveBeenCalled();
    expect(todoService.markElicitationCompleted).not.toHaveBeenCalled();

    service.stop();
  });

  it('should not fail on malformed messages', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new ElicitationSubscriberService();
    service.start();

    const handler = getMessageHandler();
    await handler('elicitation:request', 'not-json');

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();

    service.stop();
  });
});

describe('ElicitationSubscriberService - resolved', () => {
  function setup() {
    const service = new ElicitationSubscriberService();
    service.start();
    return { service, handler: getMessageHandler() };
  }

  it('T-ES1: 订阅 elicitation:resolved channel', () => {
    const { service } = setup();
    const channels = mockSubscriber.subscribe.mock.calls[0];
    expect(channels).toContain('elicitation:request');
    expect(channels).toContain('elicitation:complete');
    expect(channels).toContain('elicitation:resolved');
    service.stop();
  });

  it('T-ES2: resolved(timeout) → markElicitationResolved(expired) 且带 userId 归属', async () => {
    const { service, handler } = setup();
    vi.mocked(todoService.markElicitationResolved).mockResolvedValue(1);
    await handler('elicitation:resolved', JSON.stringify({
      requestId: 'elic-1',
      sessionId: 'sess-1',
      reason: 'timeout',
      userId: 'user-1',
    }));
    expect(todoService.markElicitationResolved).toHaveBeenCalledWith('elic-1', 'expired', {
      userId: 'user-1',
      sessionId: 'sess-1',
    });
    service.stop();
  });

  it('T-ES3: 缺 requestId 时按 sessionId 兜底收敛（不静默丢弃）', async () => {
    const { service, handler } = setup();
    vi.mocked(todoService.markElicitationResolved).mockResolvedValue(1);
    await handler('elicitation:resolved', JSON.stringify({
      sessionId: 'sess-1',
      reason: 'unsupported_mode',
      detail: 'custom',
      userId: 'user-1',
    }));
    expect(todoService.markElicitationResolved).toHaveBeenCalledWith(undefined, 'failed', {
      userId: 'user-1',
      sessionId: 'sess-1',
    });
    service.stop();
  });

  it('T-ES3b: resolved(unsupported_mode) 带 requestId → failed', async () => {
    const { service, handler } = setup();
    vi.mocked(todoService.markElicitationResolved).mockResolvedValue(1);
    await handler('elicitation:resolved', JSON.stringify({
      requestId: 'elic-2',
      sessionId: 'sess-1',
      reason: 'unsupported_mode',
      userId: 'user-1',
    }));
    expect(todoService.markElicitationResolved).toHaveBeenCalledWith('elic-2', 'failed', {
      userId: 'user-1',
      sessionId: 'sess-1',
    });
    service.stop();
  });

  it('T-ES4: resolved(cancelled) → cancelled', async () => {
    const { service, handler } = setup();
    vi.mocked(todoService.markElicitationResolved).mockResolvedValue(1);
    await handler('elicitation:resolved', JSON.stringify({
      requestId: 'elic-3',
      sessionId: 'sess-1',
      reason: 'cancelled',
      userId: 'user-1',
    }));
    expect(todoService.markElicitationResolved).toHaveBeenCalledWith('elic-3', 'cancelled', {
      userId: 'user-1',
      sessionId: 'sess-1',
    });
    service.stop();
  });

  it('T-ES5: 缺 userId 时拒绝写入（租户隔离）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service, handler } = setup();
    await handler('elicitation:resolved', JSON.stringify({
      requestId: 'elic-4',
      sessionId: 'sess-1',
      reason: 'timeout',
    }));
    expect(todoService.markElicitationResolved).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('without userId'), expect.anything(), expect.anything());
    warnSpy.mockRestore();
    service.stop();
  });

  it('T-ES6: 未知 reason 收敛为 failed 并告警（不静默按 cancelled 处理）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service, handler } = setup();
    vi.mocked(todoService.markElicitationResolved).mockResolvedValue(1);
    await handler('elicitation:resolved', JSON.stringify({
      requestId: 'elic-5',
      sessionId: 'sess-1',
      reason: 'protocol_drift',
      userId: 'user-1',
    }));
    expect(todoService.markElicitationResolved).toHaveBeenCalledWith('elic-5', 'failed', {
      userId: 'user-1',
      sessionId: 'sess-1',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown reason'),
      'protocol_drift',
      'elic-5',
    );
    warnSpy.mockRestore();
    service.stop();
  });
});
