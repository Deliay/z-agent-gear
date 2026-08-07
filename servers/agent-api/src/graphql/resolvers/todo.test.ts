import { describe, it, expect, vi, beforeEach } from 'vitest';
import { todoResolvers } from './todo.js';

vi.mock('../../services/todo-service.js', () => ({
  todoService: {
    getTodoList: vi.fn(),
    getUnreadTodoCount: vi.fn(),
    markTodoRead: vi.fn(),
    markAllTodoRead: vi.fn(),
    markTodoAsResponded: vi.fn(),
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
});

describe('Todo Resolvers', () => {
  describe('Mutation.respondElicitation', () => {
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
      expect(todoService.markTodoAsResponded).toHaveBeenCalledWith('elic-1');
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
});
