import { GraphQLError } from 'graphql';
import { controllerWorkspaceService } from '../../services/controller-workspace.js';
import { folderBrowserService } from '../../services/folder-browser.js';
import type { AuthContext } from './auth.js';

export const controllerWorkspaceResolvers = {
  Query: {
    controllerWorkspaces: async (
      _parent: unknown,
      args: { controllerId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return controllerWorkspaceService.findAllByController(args.controllerId, context.currentUser.id);
    },
    browseFolder: async (
      _parent: unknown,
      args: { controllerId: string; path?: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await folderBrowserService.browse(args.controllerId, context.currentUser.id, args.path);
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
    getHomeDirectory: async (
      _parent: unknown,
      args: { controllerId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await folderBrowserService.getHomeDirectory(args.controllerId, context.currentUser.id);
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
  },
  Mutation: {
    createWorkspace: async (
      _parent: unknown,
      args: { input: { controllerId: string; path: string } },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await controllerWorkspaceService.create(
          args.input.controllerId,
          context.currentUser.id,
          args.input.path,
        );
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
    deleteWorkspace: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return controllerWorkspaceService.delete(args.id, context.currentUser.id);
    },
    clearWorkspaces: async (
      _parent: unknown,
      args: { controllerId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return controllerWorkspaceService.clear(args.controllerId, context.currentUser.id);
    },
    toggleWorkspace: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const result = await controllerWorkspaceService.toggle(args.id, context.currentUser.id);
      if (!result) {
        throw new GraphQLError('Workspace not found');
      }
      return result;
    },
  },
};
