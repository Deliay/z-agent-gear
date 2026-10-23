import { GraphQLError } from 'graphql';
import { controllerKeyService } from '../../services/controller-key.js';
import { controllerService } from '../../services/controller.js';
import { McpServer } from '../../models/mcp-server.js';
import type { AuthContext } from './auth.js';

type Doc = Record<string, unknown>;

export const controllerResolvers = {
  Controller: {
    /**
     * 默认 MCP 归一：历史行缺失 → { useAllEnabled: true, serverIds: [] }；
     * serverIds 输出为字符串数组，并过滤已被删除的服务（展示口径，保存时校验严格）。
     */
    defaultMcp: async (parent: Doc, _args: unknown, context: AuthContext) => {
      const raw = (parent.defaultMcp ?? {}) as {
        useAllEnabled?: boolean | null;
        serverIds?: unknown[] | null;
      };
      const useAllEnabled = raw.useAllEnabled !== false;
      const serverIds = (raw.serverIds ?? []).map((id) => String(id));
      if (serverIds.length === 0) return { useAllEnabled, serverIds: [] };
      const userId = context.currentUser?.id;
      if (!userId) return { useAllEnabled, serverIds };
      const existing = await McpServer.find({ _id: { $in: serverIds }, userId })
        .select('_id')
        .lean();
      const existingIds = new Set(existing.map((server) => String(server._id)));
      return { useAllEnabled, serverIds: serverIds.filter((id) => existingIds.has(id)) };
    },
  },
  Query: {
    controllerKeys: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return controllerKeyService.findAllByUser(context.currentUser.id);
    },
    controllers: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return controllerService.findAllByUser(context.currentUser.id);
    },
    controller: async (_parent: unknown, args: { id: string }, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return controllerService.findById(args.id, context.currentUser.id);
    },
  },
  Mutation: {
    createControllerKey: async (
      _parent: unknown,
      args: { input: { name: string; type: string } },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return controllerKeyService.create(context.currentUser.id, args.input);
    },
    renameControllerKey: async (
      _parent: unknown,
      args: { input: { id: string; name: string } },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const result = await controllerKeyService.rename(
        args.input.id,
        context.currentUser.id,
        args.input.name,
      );
      if (!result) {
        throw new GraphQLError('Key not found');
      }
      return result;
    },
    renameController: async (
      _parent: unknown,
      args: { input: { id: string; name: string } },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const result = await controllerService.rename(
        args.input.id,
        context.currentUser.id,
        args.input.name,
      );
      if (!result) {
        throw new GraphQLError('Controller not found');
      }
      return result;
    },
    unbindController: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return controllerService.unbind(args.id, context.currentUser.id);
    },
    setControllerWorktreeDir: async (
      _parent: unknown,
      args: { controllerId: string; worktreeDir: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const result = await controllerService.setWorktreeDir(
        args.controllerId,
        context.currentUser.id,
        args.worktreeDir,
      );
      if (!result) {
        throw new GraphQLError('Controller not found');
      }
      return result;
    },
    setControllerDefaultMcp: async (
      _parent: unknown,
      args: { controllerId: string; useAllEnabled: boolean; serverIds?: string[] | null },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        const result = await controllerService.setDefaultMcp(
          context.currentUser.id,
          args.controllerId,
          { useAllEnabled: args.useAllEnabled, serverIds: args.serverIds },
        );
        if (!result) {
          throw new GraphQLError('Controller not found');
        }
        return result;
      } catch (err) {
        if (err instanceof GraphQLError) throw err;
        if ((err as Error).message === 'MCP_SERVER_NOT_FOUND') {
          throw new GraphQLError('MCP_SERVER_NOT_FOUND');
        }
        throw new GraphQLError((err as Error).message);
      }
    },
    regenerateControllerKey: async (
      _parent: unknown,
      args: { input: { controllerId: string } },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const result = await controllerKeyService.regenerate(
        args.input.controllerId,
        context.currentUser.id,
      );
      if (!result) {
        throw new GraphQLError('Controller not found');
      }
      return result;
    },
  },
};
