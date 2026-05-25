import { GraphQLError } from 'graphql';
import { controllerKeyService } from '../../services/controller-key.js';
import { controllerService } from '../../services/controller.js';
import type { AuthContext } from './auth.js';

export const controllerResolvers = {
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
  },
};
