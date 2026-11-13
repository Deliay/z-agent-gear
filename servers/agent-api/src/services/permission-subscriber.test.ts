import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('./todo-service.js', () => ({
  todoService: {
    createPermissionTodo: vi.fn(),
    markTodoAsResponded: vi.fn(),
  },
}));

vi.mock('./session-sse.js', () => ({
  sessionSSEService: {
    pushToUser: vi.fn(),
  },
}));

vi.mock('./session-interaction-service.js', () => ({
  sessionInteractionService: {
    createFromPermissionRequest: vi.fn(),
    resolve: vi.fn(),
  },
}));

import { getRedisClient } from '../middleware/redis.js';
import { todoService } from './todo-service.js';
import { sessionSSEService } from './session-sse.js';
import { sessionInteractionService } from './session-interaction-service.js';
import { logger as rootLogger } from '../observability/logger.js';
import { createTestLogger } from '../observability/testing.js';

const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const { PermissionSubscriberService } = await import('./permission-subscriber.js');
childSpy.mockRestore();

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

const requestPayload = {
  requestId: 'perm-1',
  controllerId: 'ctrl-1',
  sessionId: 'sess-1',
  userId: 'user-1',
  toolCall: { toolCallId: 'tc-1', title: 'Bash: npm test', kind: 'execute' },
  options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  testLog.reset();
  mockRedis.duplicate.mockReturnValue(mockSubscriber);
  mockSubscriber.subscribe.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null) => void;
    cb(null);
  });
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
  vi.mocked(todoService.createPermissionTodo).mockResolvedValue({
    _id: 'todo-1',
    createdAt: new Date('2026-11-13T00:00:00Z'),
  } as never);
  vi.mocked(todoService.markTodoAsResponded).mockResolvedValue(true);
  vi.mocked(sessionInteractionService.createFromPermissionRequest).mockResolvedValue({
    interaction: { interactionId: 'perm-1' },
    created: true,
  });
  vi.mocked(sessionInteractionService.resolve).mockResolvedValue(1);
});

describe('PermissionSubscriberService', () => {
  it('T-SUB1: 订阅 permission:request 与 permission:resolved', () => {
    const service = new PermissionSubscriberService();
    service.start();
    const channels = mockSubscriber.subscribe.mock.calls[0];
    expect(channels).toContain('permission:request');
    expect(channels).toContain('permission:resolved');
    service.stop();
  });

  it('T-SUB2: request → 落库交互 + 建待办 + 双 SSE 事件（通知 + session_interaction）', async () => {
    const service = new PermissionSubscriberService();
    service.start();
    const handler = getMessageHandler();

    await handler('permission:request', JSON.stringify(requestPayload));

    expect(sessionInteractionService.createFromPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'perm-1', userId: 'user-1' }),
    );
    expect(todoService.createPermissionTodo).toHaveBeenCalled();
    expect(sessionSSEService.pushToUser).toHaveBeenCalledWith('user-1', {
      type: 'permission_request',
      data: expect.objectContaining({ requestId: 'perm-1', todoId: 'todo-1' }),
    });
    expect(sessionSSEService.pushToUser).toHaveBeenCalledWith('user-1', {
      type: 'session_interaction',
      data: {
        sessionId: 'sess-1',
        interactionId: 'perm-1',
        kind: 'PERMISSION',
        status: 'PENDING',
      },
    });
    service.stop();
  });

  it('T-SUB3: 重复 requestId（created=false）不重复建待办/推送', async () => {
    vi.mocked(sessionInteractionService.createFromPermissionRequest).mockResolvedValue({
      interaction: { interactionId: 'perm-1' },
      created: false,
    });
    const service = new PermissionSubscriberService();
    service.start();

    await getMessageHandler()('permission:request', JSON.stringify(requestPayload));

    expect(todoService.createPermissionTodo).not.toHaveBeenCalled();
    expect(sessionSSEService.pushToUser).not.toHaveBeenCalled();
    service.stop();
  });

  it('T-SUB4: resolved(timeout) → EXPIRED 收敛 + 通知已读 + 终态 SSE', async () => {
    const service = new PermissionSubscriberService();
    service.start();

    await getMessageHandler()('permission:resolved', JSON.stringify({
      requestId: 'perm-1',
      sessionId: 'sess-1',
      reason: 'timeout',
      userId: 'user-1',
      detail: 'controller-api timeout (60s)',
    }));

    expect(sessionInteractionService.resolve).toHaveBeenCalledWith({
      userId: 'user-1',
      interactionId: 'perm-1',
      sessionId: 'sess-1',
      resolution: 'EXPIRED',
      detail: 'controller-api timeout (60s)',
    });
    expect(todoService.markTodoAsResponded).toHaveBeenCalledWith('perm-1', 'user-1');
    expect(sessionSSEService.pushToUser).toHaveBeenCalledWith('user-1', {
      type: 'session_interaction',
      data: {
        sessionId: 'sess-1',
        interactionId: 'perm-1',
        kind: 'PERMISSION',
        status: 'EXPIRED',
      },
    });
    service.stop();
  });

  it('T-SUB5: resolved(cancelled) → CANCELLED；契约外 reason → FAILED 并告警', async () => {
    const service = new PermissionSubscriberService();
    service.start();
    const handler = getMessageHandler();

    await handler('permission:resolved', JSON.stringify({
      requestId: 'perm-1', sessionId: 'sess-1', reason: 'cancelled', userId: 'user-1',
    }));
    expect(sessionInteractionService.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'CANCELLED' }),
    );

    vi.mocked(sessionInteractionService.resolve).mockClear();
    await handler('permission:resolved', JSON.stringify({
      requestId: 'perm-2', sessionId: 'sess-1', reason: 'weird', userId: 'user-1',
    }));
    expect(sessionInteractionService.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'FAILED' }),
    );
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(true);
    service.stop();
  });

  it('T-SUB6: 缺 userId 拒绝写入（租户隔离红线）', async () => {
    const service = new PermissionSubscriberService();
    service.start();

    await getMessageHandler()('permission:resolved', JSON.stringify({
      requestId: 'perm-1', sessionId: 'sess-1', reason: 'timeout',
    }));

    expect(sessionInteractionService.resolve).not.toHaveBeenCalled();
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(true);
    service.stop();
  });

  it('T-SUB7: requestId 缺失按 sessionId 会话级兜底', async () => {
    const service = new PermissionSubscriberService();
    service.start();

    await getMessageHandler()('permission:resolved', JSON.stringify({
      sessionId: 'sess-1', reason: 'cancelled', userId: 'user-1',
    }));

    expect(sessionInteractionService.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ interactionId: undefined, sessionId: 'sess-1' }),
    );
    service.stop();
  });
});
