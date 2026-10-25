import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('./todo-service.js', () => ({
  todoService: {
    createHarnessLoginTodo: vi.fn(),
    markHarnessLoginResolved: vi.fn(),
    markTodoAsResponded: vi.fn(),
  },
}));

vi.mock('./session-sse.js', () => ({
  sessionSSEService: {
    pushToUser: vi.fn(),
  },
}));

import { HarnessLoginSubscriberService } from './harness-login-subscriber.js';
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

const mockRedis = { duplicate: vi.fn() };

function getMessageHandler(): MessageHandler {
  const call = mockSubscriber.on.mock.calls.find(([event]) => event === 'message');
  if (!call) throw new Error('message handler not registered');
  return call[1] as MessageHandler;
}

const requiredPayload = {
  requestId: 'hl-1',
  controllerId: 'ctrl-1',
  userId: 'user-1',
  serverType: 'kimi_code',
  trigger: 'probe-options',
  url: 'https://www.kimi.com/code/authorize_device?user_code=4CQ4-0XIG',
  userCode: '4CQ4-0XIG',
  expiresInSeconds: 1800,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.duplicate.mockReturnValue(mockSubscriber);
  mockSubscriber.subscribe.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null) => void;
    cb(null);
  });
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
});

describe('HarnessLoginSubscriberService', () => {
  it('subscribes to required/resolved channels', () => {
    const service = new HarnessLoginSubscriberService();
    service.start();

    expect(mockSubscriber.subscribe).toHaveBeenCalledWith(
      'harness:login:required',
      'harness:login:resolved',
      expect.any(Function),
    );
    service.stop();
  });

  it('T-HLS1: required 创建 todo 并推送用户 SSE', async () => {
    vi.mocked(todoService.createHarnessLoginTodo).mockResolvedValue({
      created: true,
      todo: {
        _id: 'todo-1',
        createdAt: new Date('2026-10-25T00:00:00Z'),
        harnessLoginData: { expiresAt: new Date('2026-10-25T00:30:00Z') },
      },
    } as never);

    const service = new HarnessLoginSubscriberService();
    service.start();
    await getMessageHandler()('harness:login:required', JSON.stringify(requiredPayload));

    expect(todoService.createHarnessLoginTodo).toHaveBeenCalledWith(requiredPayload);
    expect(sessionSSEService.pushToUser).toHaveBeenCalledWith('user-1', {
      type: 'harness_login_required',
      data: expect.objectContaining({
        requestId: 'hl-1',
        controllerId: 'ctrl-1',
        serverType: 'kimi_code',
        trigger: 'probe-options',
        url: requiredPayload.url,
        userCode: '4CQ4-0XIG',
        expiresAt: '2026-10-25T00:30:00.000Z',
        todoId: 'todo-1',
      }),
    });
    service.stop();
  });

  it('T-HLS2: 重复 required（created=false）不重复推送', async () => {
    vi.mocked(todoService.createHarnessLoginTodo).mockResolvedValue({
      created: false,
      todo: { _id: 'todo-1' },
    } as never);

    const service = new HarnessLoginSubscriberService();
    service.start();
    await getMessageHandler()('harness:login:required', JSON.stringify(requiredPayload));

    expect(sessionSSEService.pushToUser).not.toHaveBeenCalled();
    service.stop();
  });

  it('T-HLS3: resolved 终态映射（succeeded→accepted / cancelled / expired / 未知→failed）', async () => {
    const service = new HarnessLoginSubscriberService();
    service.start();
    const handler = getMessageHandler();
    vi.mocked(todoService.markHarnessLoginResolved).mockResolvedValue(1 as never);

    for (const [result, expected] of [
      ['succeeded', 'accepted'],
      ['cancelled', 'cancelled'],
      ['expired', 'expired'],
      ['failed', 'failed'],
      ['bogus', 'failed'],
    ] as const) {
      vi.clearAllMocks();
      await handler('harness:login:resolved', JSON.stringify({
        requestId: 'hl-1', controllerId: 'ctrl-1', userId: 'user-1', result,
      }));
      expect(todoService.markHarnessLoginResolved).toHaveBeenCalledWith('hl-1', expected, { userId: 'user-1' });
    }
    service.stop();
  });

  it('T-HLS3b: resolved 推送用户 SSE 并标记已读', async () => {
    vi.mocked(todoService.markHarnessLoginResolved).mockResolvedValue(1 as never);

    const service = new HarnessLoginSubscriberService();
    service.start();
    await getMessageHandler()('harness:login:resolved', JSON.stringify({
      requestId: 'hl-1', controllerId: 'ctrl-1', userId: 'user-1', result: 'succeeded', account: 'managed:kimi-code',
    }));

    expect(todoService.markTodoAsResponded).toHaveBeenCalledWith('hl-1', 'user-1');
    expect(sessionSSEService.pushToUser).toHaveBeenCalledWith('user-1', {
      type: 'harness_login_resolved',
      data: { requestId: 'hl-1', result: 'succeeded', account: 'managed:kimi-code' },
    });
    service.stop();
  });

  it('T-HLS4: 缺 userId 的 required/resolved 不落库、不推送', async () => {
    const service = new HarnessLoginSubscriberService();
    service.start();
    const handler = getMessageHandler();

    await handler('harness:login:required', JSON.stringify({ ...requiredPayload, userId: '' }));
    await handler('harness:login:resolved', JSON.stringify({ requestId: 'hl-1', result: 'succeeded' }));

    expect(todoService.createHarnessLoginTodo).not.toHaveBeenCalled();
    expect(todoService.markHarnessLoginResolved).not.toHaveBeenCalled();
    expect(sessionSSEService.pushToUser).not.toHaveBeenCalled();
    service.stop();
  });
});
