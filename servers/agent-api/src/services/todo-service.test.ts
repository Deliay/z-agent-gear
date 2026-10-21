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
    title: 'Agent请求权限：tc-1',
    description: '工具调用 tc-1 请求权限',
    isRead: false,
    data: {
      requestId: 'req-1',
      sessionId: oid('sess-1'),
      toolCallId: 'tc-1',
      toolCall: { toolCallId: 'tc-1' },
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
        title: 'Agent请求权限：tc-1',
        description: '工具调用 tc-1 请求权限',
        data: {
          requestId: 'req-1',
          sessionId: 'sess-1',
          toolCallId: 'tc-1',
          toolCall: { toolCallId: 'tc-1' },
          options: [{ optionId: 'opt-1', name: '允许一次', kind: 'allow_once' }],
        },
      }));
      expect(result).toBe(mockTodo);
    });

    it('should store the full toolCall in data.toolCall', async () => {
      vi.mocked(TodoItem.create).mockResolvedValue(mockTodoDoc() as never);

      const toolCall = {
        toolCallId: 'tc-1',
        title: 'Bash: npm test',
        kind: 'execute',
        rawInput: { command: 'npm test' },
        locations: [{ path: 'package.json', line: 10 }],
      };

      await service.createPermissionTodo({
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        sessionId: 'sess-1',
        userId: 'user-1',
        toolCall,
        options: [],
      });

      expect(TodoItem.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          toolCallId: 'tc-1',
          toolCall,
        }),
      }));
    });

    it('should use toolCall title when present', async () => {
      vi.mocked(TodoItem.create).mockResolvedValue(mockTodoDoc() as never);

      await service.createPermissionTodo({
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        sessionId: 'sess-1',
        userId: 'user-1',
        toolCall: { toolCallId: 'tc-1', title: 'Bash: npm test' },
        options: [],
      });

      expect(TodoItem.create).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Agent请求权限：Bash: npm test',
      }));
    });

    it('should fall back to toolCallId when title is missing', async () => {
      vi.mocked(TodoItem.create).mockResolvedValue(mockTodoDoc() as never);

      await service.createPermissionTodo({
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        sessionId: 'sess-1',
        userId: 'user-1',
        toolCall: { toolCallId: 'tc-1', kind: 'think' },
        options: [],
      });

      expect(TodoItem.create).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Agent请求权限：tc-1',
        description: '工具调用 tc-1 请求权限',
      }));
    });

    it('should summarize command for execute tool calls', async () => {
      vi.mocked(TodoItem.create).mockResolvedValue(mockTodoDoc() as never);

      await service.createPermissionTodo({
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        sessionId: 'sess-1',
        userId: 'user-1',
        toolCall: { toolCallId: 'tc-1', kind: 'execute', rawInput: { command: 'npm test' } },
        options: [],
      });

      expect(TodoItem.create).toHaveBeenCalledWith(expect.objectContaining({
        description: '执行命令：npm test',
      }));
    });

    it('should summarize file path for edit tool calls', async () => {
      vi.mocked(TodoItem.create).mockResolvedValue(mockTodoDoc() as never);

      await service.createPermissionTodo({
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        sessionId: 'sess-1',
        userId: 'user-1',
        toolCall: { toolCallId: 'tc-1', kind: 'edit', rawInput: { path: 'src/index.ts' } },
        options: [],
      });

      expect(TodoItem.create).toHaveBeenCalledWith(expect.objectContaining({
        description: '操作文件：src/index.ts',
      }));
    });

    it('should list locations in the summary', async () => {
      vi.mocked(TodoItem.create).mockResolvedValue(mockTodoDoc() as never);

      await service.createPermissionTodo({
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        sessionId: 'sess-1',
        userId: 'user-1',
        toolCall: {
          toolCallId: 'tc-1',
          kind: 'execute',
          rawInput: { command: 'npm test' },
          locations: [{ path: 'a.ts' }, { path: 'b.ts', line: 3 }],
        },
        options: [],
      });

      expect(TodoItem.create).toHaveBeenCalledWith(expect.objectContaining({
        description: '执行命令：npm test；涉及位置：a.ts、b.ts',
      }));
    });

    it('should truncate long summaries to 200 characters', async () => {
      vi.mocked(TodoItem.create).mockResolvedValue(mockTodoDoc() as never);

      await service.createPermissionTodo({
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        sessionId: 'sess-1',
        userId: 'user-1',
        toolCall: { toolCallId: 'tc-1', kind: 'execute', rawInput: { command: 'x'.repeat(500) } },
        options: [],
      });

      const callArgs = vi.mocked(TodoItem.create).mock.calls[0][0] as { description: string };
      expect(callArgs.description.length).toBe(200);
      expect(callArgs.description.endsWith('...')).toBe(true);
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

  describe('createElicitationTodo', () => {
    it('should create an elicitation todo with correct fields', async () => {
      const mockTodo = mockTodoDoc({ type: 'elicitation_request' });
      vi.mocked(TodoItem.create).mockResolvedValue(mockTodo as never);

      const requestedSchema = { type: 'object', title: '填写发布信息', properties: { name: { type: 'string' } } };

      const result = await service.createElicitationTodo({
        requestId: 'elic_1',
        controllerId: 'ctrl-1',
        sessionId: 'sess-1',
        userId: 'user-1',
        mode: 'form',
        message: '请提供发布所需的信息',
        toolCallId: 'tc-1',
        requestedSchema,
      });

      expect(TodoItem.create).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-1',
        type: 'elicitation_request',
        priority: 'immediate',
        title: 'Agent请求输入：填写发布信息',
        description: '请提供发布所需的信息',
        elicitationData: {
          requestId: 'elic_1',
          sessionId: 'sess-1',
          toolCallId: 'tc-1',
          mode: 'form',
          message: '请提供发布所需的信息',
          requestedSchema,
          elicitationId: undefined,
          url: undefined,
        },
      }));
      expect(result).toBe(mockTodo);
    });

    it('should use url mode title for url elicitations', async () => {
      vi.mocked(TodoItem.create).mockResolvedValue(mockTodoDoc() as never);

      await service.createElicitationTodo({
        requestId: 'elic_2',
        controllerId: 'ctrl-1',
        sessionId: 'sess-1',
        userId: 'user-1',
        mode: 'url',
        message: '请打开链接完成授权',
        elicitationId: 'agent-elic-1',
        url: 'https://example.com/oauth',
      });

      expect(TodoItem.create).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Agent请求输入：打开链接授权',
        elicitationData: expect.objectContaining({
          mode: 'url',
          elicitationId: 'agent-elic-1',
          url: 'https://example.com/oauth',
        }),
      }));
    });

    it('should fall back to default title when requestedSchema has no title', async () => {
      vi.mocked(TodoItem.create).mockResolvedValue(mockTodoDoc() as never);

      await service.createElicitationTodo({
        requestId: 'elic_3',
        controllerId: 'ctrl-1',
        sessionId: 'sess-1',
        userId: 'user-1',
        mode: 'form',
        message: '请填写信息',
      });

      expect(TodoItem.create).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Agent请求输入：填写信息',
      }));
    });

    it('should set expiresAt to 5 minutes from now', async () => {
      const before = Date.now();
      vi.mocked(TodoItem.create).mockResolvedValue(mockTodoDoc() as never);

      await service.createElicitationTodo({
        requestId: 'elic_4',
        controllerId: 'ctrl-1',
        sessionId: 'sess-1',
        userId: 'user-1',
        mode: 'form',
        message: '请填写信息',
      });

      const callArgs = vi.mocked(TodoItem.create).mock.calls[0][0] as { expiresAt: Date };
      const expiresAtMs = callArgs.expiresAt.getTime();
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
      expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 100);
    });
  });

  describe('createWorkflowInterventionTodo', () => {
    it('should create an immediate workflow_intervention todo with node context', async () => {
      const mockTodo = mockTodoDoc({ type: 'workflow_intervention' });
      vi.mocked(TodoItem.create).mockResolvedValue(mockTodo as never);

      const result = await service.createWorkflowInterventionTodo({
        userId: 'user-1',
        instanceId: 'inst-1',
        instanceName: 'demo-instance',
        nodeId: 'n2',
        nodeName: '技术方案',
        sessionId: 'sess-2',
        reason: '会话再次进入空闲且节点未推进',
      });

      expect(TodoItem.create).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-1',
        type: 'workflow_intervention',
        priority: 'immediate',
        title: expect.stringContaining('技术方案'),
        description: expect.stringContaining('会话再次进入空闲且节点未推进'),
      }));
      expect(result).toBe(mockTodo);
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
    it('should mark todo with matching requestId as read (permission or elicitation)', async () => {
      vi.mocked(TodoItem.updateOne).mockResolvedValue({ modifiedCount: 1 } as never);

      await service.markTodoAsResponded('req-1', 'user-1');

      expect(TodoItem.updateOne).toHaveBeenCalledWith(
        {
          userId: 'user-1',
          $or: [{ 'data.requestId': 'req-1' }, { 'elicitationData.requestId': 'req-1' }],
        },
        { $set: { isRead: true } },
      );
    });
  });

  describe('markElicitationCompleted', () => {
    it('should mark elicitation todo with matching elicitationId as read', async () => {
      vi.mocked(TodoItem.updateOne).mockResolvedValue({ modifiedCount: 1 } as never);

      await service.markElicitationCompleted('elic-id-1', 'user-1');

      expect(TodoItem.updateOne).toHaveBeenCalledWith(
        { 'elicitationData.elicitationId': 'elic-id-1', userId: 'user-1' },
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

describe('TodoService - elicitation resolution', () => {
  let service: TodoService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TodoService();
  });

  it('T-TD1: markElicitationResolved 带 userId 与 resolution:null 终态守卫写入', async () => {
    vi.mocked(TodoItem.updateOne).mockResolvedValue({ modifiedCount: 1 } as never);

    const updated = await service.markElicitationResolved('elic-1', 'expired', { userId: 'user-1' });

    expect(updated).toBe(1);
    expect(TodoItem.updateOne).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        resolution: null,
        'elicitationData.requestId': 'elic-1',
      },
      {
        $set: {
          resolution: 'expired',
          resolvedAt: expect.any(Date),
          isRead: true,
        },
      },
    );
  });

  it('T-TD2: 不存在的 requestId 不抛错（modifiedCount=0）', async () => {
    vi.mocked(TodoItem.updateOne).mockResolvedValue({ modifiedCount: 0 } as never);

    await expect(
      service.markElicitationResolved('missing', 'failed', { userId: 'user-1' }),
    ).resolves.toBe(0);
  });

  it('T-TD3: 跨用户 requestId 不命中（filter 带 userId，modifiedCount=0）', async () => {
    // 数据层只有「本人 + 待处理」一条命中：他人 requestId 的 updateOne 必然 modifiedCount=0
    vi.mocked(TodoItem.updateOne).mockResolvedValue({ modifiedCount: 0 } as never);

    const updated = await service.markElicitationResolved('elic-of-user-2', 'accepted', {
      userId: 'user-1',
    });

    expect(updated).toBe(0);
    expect(TodoItem.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', resolution: null }),
      expect.anything(),
    );
  });

  it('T-TD4: accepted 后迟到 timeout 不覆盖（终态条件 resolution:null 恒不命中）', async () => {
    vi.mocked(TodoItem.updateOne).mockResolvedValue({ modifiedCount: 0 } as never);

    const updated = await service.markElicitationResolved('elic-1', 'expired', { userId: 'user-1' });

    expect(updated).toBe(0);
    const [filter, update] = vi.mocked(TodoItem.updateOne).mock.calls[0] as unknown as [
      Record<string, unknown>,
      { $set: { resolution: string } },
    ];
    expect(filter.resolution).toBeNull();
    expect(update.$set.resolution).toBe('expired');
  });

  it('T-TD5: 缺 userId 直接拒绝写入（越权防线）', async () => {
    await expect(
      service.markElicitationResolved('elic-1', 'accepted', { userId: '' }),
    ).resolves.toBe(0);
    expect(TodoItem.updateOne).not.toHaveBeenCalled();
  });

  it('T-TD6: requestId 缺失时按 sessionId + userId 会话级兜底收敛', async () => {
    vi.mocked(TodoItem.updateOne).mockResolvedValue({ modifiedCount: 1 } as never);

    const updated = await service.markElicitationResolved(undefined, 'failed', {
      userId: 'user-1',
      sessionId: 'sess-1',
    });

    expect(updated).toBe(1);
    expect(TodoItem.updateOne).toHaveBeenCalledWith(
      {
        userId: 'user-1',
        resolution: null,
        'elicitationData.sessionId': 'sess-1',
      },
      expect.anything(),
    );
  });

  it('T-TD7: requestId 与 sessionId 都缺失时不写库', async () => {
    await expect(
      service.markElicitationResolved(undefined, 'failed', { userId: 'user-1' }),
    ).resolves.toBe(0);
    expect(TodoItem.updateOne).not.toHaveBeenCalled();
  });
});
