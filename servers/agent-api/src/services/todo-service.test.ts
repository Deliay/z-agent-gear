import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/todo-item.js', () => ({
  TodoItem: {
    create: vi.fn(),
    find: vi.fn(),
    countDocuments: vi.fn(),
    updateOne: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock('../models/session.js', () => ({
  Session: {
    findById: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('../models/user.js', () => ({
  User: {
    findById: vi.fn(),
    updateOne: vi.fn(),
  },
}));

import { TodoService } from './todo-service.js';
import { TodoItem } from '../models/todo-item.js';
import { Session } from '../models/session.js';
import { User } from '../models/user.js';

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

function mockTodoDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: oid('todo-1'),
    userId: oid('user-1'),
    type: 'permission_request',
    priority: 'immediate',
    title: 'Agent请求权限审批',
    description: '工具调用 tc-1 请求权限',
    isRead: false,
    data: {
      requestId: 'req-1',
      sessionId: oid('sess-1'),
      toolCallId: 'tc-1',
      options: [{ optionId: 'opt-1', name: '允许一次', kind: 'allow_once' }],
    },
    expiresAt: new Date(Date.now() + 300_000),
    createdAt: new Date('2026-05-28'),
    toObject() { return { ...this }; },
    ...overrides,
  };
}

describe('TodoService', () => {
  let service: TodoService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TodoService();
  });

  describe('createPermissionTodo', () => {
    it('should create a permission todo with correct fields', async () => {
      const mockTodo = mockTodoDoc();
      vi.mocked(TodoItem.create).mockResolvedValue(mockTodo as never);

      const result = await service.createPermissionTodo({
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        sessionId: 'sess-1',
        userId: 'user-1',
        toolCall: { toolCallId: 'tc-1' },
        options: [{ optionId: 'opt-1', name: '允许一次', kind: 'allow_once' }],
      });

      expect(TodoItem.create).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-1',
        type: 'permission_request',
        priority: 'immediate',
        title: 'Agent请求权限审批',
        description: '工具调用 tc-1 请求权限',
        data: {
          requestId: 'req-1',
          sessionId: 'sess-1',
          toolCallId: 'tc-1',
          options: [{ optionId: 'opt-1', name: '允许一次', kind: 'allow_once' }],
        },
      }));
      expect(result).toBe(mockTodo);
    });

    it('should set expiresAt to 5 minutes from now', async () => {
      const before = Date.now();
      vi.mocked(TodoItem.create).mockResolvedValue(mockTodoDoc() as never);

      await service.createPermissionTodo({
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        sessionId: 'sess-1',
        userId: 'user-1',
        toolCall: { toolCallId: 'tc-1' },
        options: [],
      });

      const callArgs = vi.mocked(TodoItem.create).mock.calls[0][0] as { expiresAt: Date };
      const expiresAtMs = callArgs.expiresAt.getTime();
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
      expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 100);
    });
  });

  describe('getTodoList', () => {
    it('should return todos sorted by priority and createdAt', async () => {
      const mockTodos = [mockTodoDoc(), mockTodoDoc({ _id: oid('todo-2') })];
      const chainMock = {
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(mockTodos),
      };
      vi.mocked(TodoItem.find).mockReturnValue(chainMock as never);

      const result = await service.getTodoList('user-1');

      expect(TodoItem.find).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(chainMock.sort).toHaveBeenCalledWith({ priority: 1, createdAt: -1 });
      expect(chainMock.limit).toHaveBeenCalledWith(100);
      expect(result).toEqual(mockTodos);
    });
  });

  describe('getUnreadTodoCount', () => {
    it('should return count of unread todos', async () => {
      vi.mocked(TodoItem.countDocuments).mockResolvedValue(5);

      const result = await service.getUnreadTodoCount('user-1');

      expect(TodoItem.countDocuments).toHaveBeenCalledWith({ userId: 'user-1', isRead: false });
      expect(result).toBe(5);
    });

    it('should return 0 when no unread todos', async () => {
      vi.mocked(TodoItem.countDocuments).mockResolvedValue(0);

      const result = await service.getUnreadTodoCount('user-1');

      expect(result).toBe(0);
    });
  });

  describe('markTodoRead', () => {
    it('should mark todo as read and return true', async () => {
      vi.mocked(TodoItem.updateOne).mockResolvedValue({ modifiedCount: 1 } as never);

      const result = await service.markTodoRead('user-1', 'todo-1');

      expect(TodoItem.updateOne).toHaveBeenCalledWith(
        { _id: 'todo-1', userId: 'user-1' },
        { $set: { isRead: true } },
      );
      expect(result).toBe(true);
    });

    it('should return false when todo not found', async () => {
      vi.mocked(TodoItem.updateOne).mockResolvedValue({ modifiedCount: 0 } as never);

      const result = await service.markTodoRead('user-1', 'nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('markAllTodoRead', () => {
    it('should mark all unread todos as read', async () => {
      vi.mocked(TodoItem.updateMany).mockResolvedValue({ modifiedCount: 3 } as never);

      const result = await service.markAllTodoRead('user-1');

      expect(TodoItem.updateMany).toHaveBeenCalledWith(
        { userId: 'user-1', isRead: false },
        { $set: { isRead: true } },
      );
      expect(result).toBe(true);
    });

    it('should return false when no unread todos', async () => {
      vi.mocked(TodoItem.updateMany).mockResolvedValue({ modifiedCount: 0 } as never);

      const result = await service.markAllTodoRead('user-1');

      expect(result).toBe(false);
    });
  });

  describe('markTodoAsResponded', () => {
    it('should mark todo with matching requestId as read', async () => {
      vi.mocked(TodoItem.updateOne).mockResolvedValue({ modifiedCount: 1 } as never);

      await service.markTodoAsResponded('req-1');

      expect(TodoItem.updateOne).toHaveBeenCalledWith(
        { 'data.requestId': 'req-1' },
        { $set: { isRead: true } },
      );
    });
  });

  describe('getTimeoutAction', () => {
    it('should return session action when set and not use_global', async () => {
      vi.mocked(Session.findById).mockResolvedValue({
        permissionTimeoutAction: 'reject',
      } as never);

      const result = await service.getTimeoutAction('user-1', 'sess-1');

      expect(result).toBe('reject');
    });

    it('should fall back to global when session is use_global', async () => {
      vi.mocked(Session.findById).mockResolvedValue({
        permissionTimeoutAction: 'use_global',
      } as never);
      vi.mocked(User.findById).mockResolvedValue({
        globalPermissionTimeoutAction: 'cancel',
      } as never);

      const result = await service.getTimeoutAction('user-1', 'sess-1');

      expect(result).toBe('cancel');
    });

    it('should fall back to global when session has no permissionTimeoutAction', async () => {
      vi.mocked(Session.findById).mockResolvedValue({
        permissionTimeoutAction: null,
      } as never);
      vi.mocked(User.findById).mockResolvedValue({
        globalPermissionTimeoutAction: 'reject',
      } as never);

      const result = await service.getTimeoutAction('user-1', 'sess-1');

      expect(result).toBe('reject');
    });

    it('should fall back to global when no sessionId provided', async () => {
      vi.mocked(User.findById).mockResolvedValue({
        globalPermissionTimeoutAction: 'cancel',
      } as never);

      const result = await service.getTimeoutAction('user-1');

      expect(Session.findById).not.toHaveBeenCalled();
      expect(result).toBe('cancel');
    });

    it('should return default allow_once when no settings found', async () => {
      vi.mocked(Session.findById).mockResolvedValue(null);
      vi.mocked(User.findById).mockResolvedValue(null);

      const result = await service.getTimeoutAction('user-1', 'sess-1');

      expect(result).toBe('allow_once');
    });

    it('should return default allow_once when user has no globalPermissionTimeoutAction', async () => {
      vi.mocked(Session.findById).mockResolvedValue(null);
      vi.mocked(User.findById).mockResolvedValue({
        globalPermissionTimeoutAction: null,
      } as never);

      const result = await service.getTimeoutAction('user-1', 'sess-1');

      expect(result).toBe('allow_once');
    });
  });

  describe('updatePermissionTimeout', () => {
    it('should update session timeout action', async () => {
      vi.mocked(Session.updateOne).mockResolvedValue({ modifiedCount: 1 } as never);

      const result = await service.updatePermissionTimeout('user-1', 'sess-1', 'reject');

      expect(Session.updateOne).toHaveBeenCalledWith(
        { _id: 'sess-1', userId: 'user-1' },
        { $set: { permissionTimeoutAction: 'reject' } },
      );
      expect(result).toBe(true);
    });

    it('should return false when sessionId is null', async () => {
      const result = await service.updatePermissionTimeout('user-1', null, 'reject');

      expect(Session.updateOne).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });
  });

  describe('updateGlobalPermissionTimeout', () => {
    it('should update user global timeout action', async () => {
      vi.mocked(User.updateOne).mockResolvedValue({ modifiedCount: 1 } as never);

      const result = await service.updateGlobalPermissionTimeout('user-1', 'cancel');

      expect(User.updateOne).toHaveBeenCalledWith(
        { _id: 'user-1' },
        { $set: { globalPermissionTimeoutAction: 'cancel' } },
      );
      expect(result).toBe(true);
    });

    it('should return false when user not found', async () => {
      vi.mocked(User.updateOne).mockResolvedValue({ modifiedCount: 0 } as never);

      const result = await service.updateGlobalPermissionTimeout('nonexistent', 'cancel');

      expect(result).toBe(false);
    });
  });
});
