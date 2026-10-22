import { describe, it, expect, vi, beforeEach } from 'vitest';
import { todoResolvers } from './todo.js';

vi.mock('../../services/todo-service.js', () => ({
  todoService: {
    getTodoList: vi.fn(),
    getUnreadTodoCount: vi.fn(),
    markTodoRead: vi.fn(),
    markAllTodoRead: vi.fn(),
    markTodoAsResponded: vi.fn(),
    markElicitationResolved: vi.fn(),
    isRespondableTodo: vi.fn(),
    updatePermissionTimeout: vi.fn(),
    updateGlobalPermissionTimeout: vi.fn(),
  },
}));

vi.mock('../../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { todoService } from '../../services/todo-service.js';
import { getRedisClient } from '../../middleware/redis.js';

const mockRedis = {
  publish: vi.fn(),
};

const mockContext = {
  currentUser: { id: 'user1', username: 'testuser' },
} as never;

const emptyContext = {
  currentUser: null,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
  // 默认：待办属于当前用户且可响应
  vi.mocked(todoService.isRespondableTodo).mockResolvedValue(true);
});

describe('Todo Resolvers', () => {
  describe('Mutation.respondPermission', () => {
    it('T-TR0b: 他人 requestId 拒绝代答（不 publish、不标已读）', async () => {
      vi.mocked(todoService.isRespondableTodo).mockResolvedValue(false);

      await expect(
        todoResolvers.Mutation.respondPermission(
          {},
          { requestId: 'perm-of-other-user', outcome: 'selected', optionId: 'opt-1' },
          mockContext,
        ),
      ).rejects.toThrow('Todo item not found or already handled');

      expect(todoService.isRespondableTodo).toHaveBeenCalledWith('user1', 'perm-of-other-user', 'permission_request');
      expect(mockRedis.publish).not.toHaveBeenCalled();
      expect(todoService.markTodoAsResponded).not.toHaveBeenCalled();
    });
  });

  describe('Mutation.respondElicitation', () => {
    it('T-TR0a: 他人/已终结的 requestId 拒绝回传 Agent（不 publish、不写终态）', async () => {
      vi.mocked(todoService.isRespondableTodo).mockResolvedValue(false);

      await expect(
        todoResolvers.Mutation.respondElicitation(
          {},
          { requestId: 'elic-of-other-user', action: 'accept', values: { a: 1 } },
          mockContext,
        ),
      ).rejects.toThrow('Todo item not found or already handled');

      expect(todoService.isRespondableTodo).toHaveBeenCalledWith('user1', 'elic-of-other-user', 'elicitation_request');
      expect(mockRedis.publish).not.toHaveBeenCalled();
      expect(todoService.markTodoAsResponded).not.toHaveBeenCalled();
      expect(todoService.markElicitationResolved).not.toHaveBeenCalled();
    });

    it('should throw when not authenticated', async () => {
      await expect(
        todoResolvers.Mutation.respondElicitation(
          {},
          { requestId: 'elic-1', action: 'accept', values: { a: 1 } },
          emptyContext,
        ),
      ).rejects.toThrow('Not authenticated');
    });

    it('should publish accept response with content and mark todo as responded', async () => {
      const result = await todoResolvers.Mutation.respondElicitation(
        {},
        { requestId: 'elic-1', action: 'accept', values: { strategy: 'balanced' } },
        mockContext,
      );

      expect(result).toBe(true);
      const published = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      expect(mockRedis.publish).toHaveBeenCalledWith('elicitation:response', expect.any(String));
      expect(published).toEqual({
        requestId: 'elic-1',
        action: 'accept',
        content: { strategy: 'balanced' },
      });
      expect(todoService.markTodoAsResponded).toHaveBeenCalledWith('elic-1', 'user1');
    });

    it('should publish decline without content', async () => {
      await todoResolvers.Mutation.respondElicitation(
        {},
        { requestId: 'elic-2', action: 'decline', values: { ignored: true } },
        mockContext,
      );

      const published = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      expect(published).toEqual({ requestId: 'elic-2', action: 'decline' });
      expect(published.content).toBeUndefined();
    });

    it('should publish cancel without content', async () => {
      await todoResolvers.Mutation.respondElicitation(
        {},
        { requestId: 'elic-3', action: 'cancel' },
        mockContext,
      );

      const published = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      expect(published).toEqual({ requestId: 'elic-3', action: 'cancel' });
    });
  });

  describe('field resolvers', () => {
    it('should return null data when Mongoose materialized an empty subdocument', () => {
      expect(todoResolvers.TodoItem.data({ data: {} })).toBeNull();
      expect(todoResolvers.TodoItem.data({})).toBeNull();
    });

    it('should pass through data when requestId exists', () => {
      const data = { requestId: 'req-1', toolCallId: 'tc-1' };
      expect(todoResolvers.TodoItem.data({ data })).toBe(data);
    });

    it('should return null elicitationData when Mongoose materialized an empty subdocument', () => {
      expect(todoResolvers.TodoItem.elicitationData({ elicitationData: {} })).toBeNull();
      expect(todoResolvers.TodoItem.elicitationData({ elicitationData: null })).toBeNull();
      expect(todoResolvers.TodoItem.elicitationData({})).toBeNull();
    });

    it('should pass through elicitationData when requestId exists', () => {
      const elicitationData = { requestId: 'elic-1', mode: 'form' };
      expect(todoResolvers.TodoItem.elicitationData({ elicitationData })).toBe(elicitationData);
    });

    it('should return null toolCall when Mongoose materialized an empty subdocument', () => {
      expect(todoResolvers.PermissionRequestData.toolCall({ toolCall: {} })).toBeNull();
      expect(todoResolvers.PermissionRequestData.toolCall({})).toBeNull();
    });

    it('should pass through toolCall when toolCallId exists', () => {
      const toolCall = { toolCallId: 'tc-1', title: 'Bash: ls' };
      expect(todoResolvers.PermissionRequestData.toolCall({ toolCall })).toBe(toolCall);
    });
  });
});

describe('Todo Resolvers - elicitation resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
  });

  it('T-TR1: respondElicitation(accept) 写 accepted', async () => {
    await todoResolvers.Mutation.respondElicitation(
      {},
      { requestId: 'elic-1', action: 'accept', values: { a: 1 } },
      mockContext,
    );
    expect(todoService.markElicitationResolved).toHaveBeenCalledWith('elic-1', 'accepted', { userId: 'user1' });
  });

  it('T-TR2: decline/cancel 分别写 declined/cancelled', async () => {
    await todoResolvers.Mutation.respondElicitation(
      {},
      { requestId: 'elic-2', action: 'decline' },
      mockContext,
    );
    expect(todoService.markElicitationResolved).toHaveBeenCalledWith('elic-2', 'declined', { userId: 'user1' });

    await todoResolvers.Mutation.respondElicitation(
      {},
      { requestId: 'elic-3', action: 'cancel' },
      mockContext,
    );
    expect(todoService.markElicitationResolved).toHaveBeenCalledWith('elic-3', 'cancelled', { userId: 'user1' });
  });

  it('T-TR3: expiresAt/resolvedAt Date → ISO 字符串，缺失返回 null', () => {
    expect(todoResolvers.TodoItem.expiresAt({ expiresAt: new Date('2026-10-21T00:00:00Z') }))
      .toBe('2026-10-21T00:00:00.000Z');
    expect(todoResolvers.TodoItem.resolvedAt({ resolvedAt: new Date('2026-10-21T01:00:00Z') }))
      .toBe('2026-10-21T01:00:00.000Z');
    expect(todoResolvers.TodoItem.expiresAt({})).toBeNull();
    expect(todoResolvers.TodoItem.resolvedAt({ resolvedAt: null })).toBeNull();
    expect(todoResolvers.TodoItem.resolution({})).toBeNull();
    expect(todoResolvers.TodoItem.resolution({ resolution: 'expired' })).toBe('expired');
  });
});
