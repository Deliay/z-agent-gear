import { GraphQLError } from 'graphql';
import { todoService } from '../../services/todo-service.js';
import { getRedisClient } from '../../middleware/redis.js';
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

      const redis = getRedisClient();
      await redis.publish('permission:response', JSON.stringify({
        requestId: args.requestId,
        outcome: { outcome: args.outcome, optionId: args.optionId },
      }));

      await todoService.markTodoAsResponded(args.requestId);

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

      const redis = getRedisClient();
      await redis.publish('elicitation:response', JSON.stringify({
        requestId: args.requestId,
        action: args.action,
        ...(args.action === 'accept' && args.values ? { content: args.values } : {}),
      }));

      await todoService.markTodoAsResponded(args.requestId);

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
