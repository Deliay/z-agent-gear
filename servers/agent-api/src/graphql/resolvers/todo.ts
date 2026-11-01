import { GraphQLError } from 'graphql';
import { todoService } from '../../services/todo-service.js';
import { publish } from '../../middleware/publish.js';
import type { AuthContext } from './auth.js';

export const todoResolvers = {
  // Mongoose 会把 schema 中声明的嵌套子文档物化为空对象（所有字段为 undefined），
  // 即使创建时未赋值。这里在非空校验前把它们归一为 null，
  // 避免非空标量字段（如 ElicitationRequestData.requestId）解析报错。
  TodoItem: {
    data: (todo: { data?: { requestId?: string } | null }) =>
      todo.data?.requestId ? todo.data : null,
    elicitationData: (todo: { elicitationData?: { requestId?: string } | null }) =>
      todo.elicitationData?.requestId ? todo.elicitationData : null,
    harnessLoginData: (todo: { harnessLoginData?: { requestId?: string } | null }) =>
      todo.harnessLoginData?.requestId ? todo.harnessLoginData : null,
    resolution: (todo: { resolution?: string | null }) => todo.resolution ?? null,
    resolvedAt: (todo: { resolvedAt?: Date | string | null }) =>
      todo.resolvedAt ? new Date(todo.resolvedAt).toISOString() : null,
    expiresAt: (todo: { expiresAt?: Date | string | null }) =>
      todo.expiresAt ? new Date(todo.expiresAt).toISOString() : null,
  },
  PermissionRequestData: {
    toolCall: (data: { toolCall?: { toolCallId?: string } | null }) =>
      data?.toolCall?.toolCallId ? data.toolCall : null,
  },
  Query: {
    getTodoList: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return todoService.getTodoList(context.currentUser.id);
    },
    getUnreadTodoCount: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return todoService.getUnreadTodoCount(context.currentUser.id);
    },
  },
  Mutation: {
    respondPermission: async (
      _parent: unknown,
      args: { requestId: string; outcome: string; optionId?: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }

      // 归属前置校验：必须先确认待办属于当前用户，再向 Agent 下发响应动作，
      // 否则持有他人 requestId 即可代答（例如代接受权限 → Agent 执行命令）。
      const owned = await todoService.isRespondableTodo(
        context.currentUser.id,
        args.requestId,
        'permission_request',
      );
      if (!owned) {
        throw new GraphQLError('Todo item not found or already handled');
      }

      await publish('permission:response', {
        requestId: args.requestId,
        outcome: { outcome: args.outcome, optionId: args.optionId },
      });

      await todoService.markTodoAsResponded(args.requestId, context.currentUser.id);

      return true;
    },
    respondElicitation: async (
      _parent: unknown,
      args: { requestId: string; action: 'accept' | 'decline' | 'cancel'; values?: Record<string, unknown> },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }

      // 归属 + 终态前置校验：只有本人且仍待处理的问询才允许回传 Agent
      const owned = await todoService.isRespondableTodo(
        context.currentUser.id,
        args.requestId,
        'elicitation_request',
      );
      if (!owned) {
        throw new GraphQLError('Todo item not found or already handled');
      }

      await publish('elicitation:response', {
        requestId: args.requestId,
        action: args.action,
        ...(args.action === 'accept' && args.values ? { content: args.values } : {}),
      });

      await todoService.markTodoAsResponded(args.requestId, context.currentUser.id);

      const resolution = args.action === 'accept'
        ? 'accepted'
        : args.action === 'decline'
          ? 'declined'
          : 'cancelled';
      // 归属 + 终态单调由 Service 数据层强制：仅本人、仅 null→终态
      await todoService.markElicitationResolved(args.requestId, resolution, {
        userId: context.currentUser.id,
      });

      return true;
    },
    respondHarnessLogin: async (
      _parent: unknown,
      args: { requestId: string; action: 'cancel' },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }

      // 归属 + 终态前置校验：仅本人且仍待处理的登录引导才允许下发取消
      const owned = await todoService.isRespondableTodo(
        context.currentUser.id,
        args.requestId,
        'harness_login_request',
      );
      if (!owned) {
        throw new GraphQLError('Todo item not found or already handled');
      }

      await publish('harness:login:cancel', { requestId: args.requestId });

      await todoService.markTodoAsResponded(args.requestId, context.currentUser.id);
      // 近似终态（controller 稍后回 resolved 再覆盖为同一终态；单调守卫保证不倒退）
      await todoService.markHarnessLoginResolved(args.requestId, 'cancelled', {
        userId: context.currentUser.id,
      });

      return true;
    },
    markTodoRead: async (
      _parent: unknown,
      args: { todoId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return todoService.markTodoRead(context.currentUser.id, args.todoId);
    },
    markAllTodoRead: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return todoService.markAllTodoRead(context.currentUser.id);
    },
    updatePermissionTimeout: async (
      _parent: unknown,
      args: { sessionId?: string | null; timeoutAction: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return todoService.updatePermissionTimeout(context.currentUser.id, args.sessionId ?? null, args.timeoutAction);
    },
    updateGlobalPermissionTimeout: async (
      _parent: unknown,
      args: { timeoutAction: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return todoService.updateGlobalPermissionTimeout(context.currentUser.id, args.timeoutAction);
    },
  },
};
