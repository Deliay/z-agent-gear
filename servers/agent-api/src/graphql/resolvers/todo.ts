import { GraphQLError } from 'graphql';
import { todoService } from '../../services/todo-service.js';
import { getRedisClient } from '../../middleware/redis.js';
import type { AuthContext } from './auth.js';

export const todoResolvers = {
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
