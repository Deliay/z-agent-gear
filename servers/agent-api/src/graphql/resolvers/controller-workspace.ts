import { GraphQLError } from 'graphql';
import { controllerWorkspaceService } from '../../services/controller-workspace.js';
import { folderBrowserService } from '../../services/folder-browser.js';
import { worktreeService } from '../../services/worktree.js';
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
    workspaces: async (
      _parent: unknown,
      _args: unknown,
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return controllerWorkspaceService.findAllByUser(context.currentUser.id);
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
    detectGitRepo: async (
      _parent: unknown,
      args: { controllerId: string; workspaceId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await controllerWorkspaceService.detectGitRepo(args.controllerId, args.workspaceId, context.currentUser.id);
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
    workspaceWorktrees: async (
      _parent: unknown,
      args: { controllerId: string; workspaceId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await worktreeService.list(args.controllerId, args.workspaceId, context.currentUser.id);
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
    initGitRepo: async (
      _parent: unknown,
      args: { controllerId: string; workspaceId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await controllerWorkspaceService.initGitRepo(args.controllerId, args.workspaceId, context.currentUser.id);
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
    createFolder: async (
      _parent: unknown,
      args: { controllerId: string; parentPath: string; folderName: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await controllerWorkspaceService.createFolder(args.controllerId, context.currentUser.id, args.parentPath, args.folderName);
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
    setWorkspaceDefaultBranch: async (
      _parent: unknown,
      args: { id: string; defaultBranch: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await controllerWorkspaceService.setDefaultBranch(args.id, context.currentUser.id, args.defaultBranch);
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
    deleteWorktree: async (
      _parent: unknown,
      args: { controllerId: string; workspaceId: string; worktreePath: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await worktreeService.deleteWorktree(
          args.controllerId,
          args.workspaceId,
          args.worktreePath,
          context.currentUser.id,
        );
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
  },
};
