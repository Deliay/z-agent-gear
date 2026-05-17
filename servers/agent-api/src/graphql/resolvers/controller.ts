import { GraphQLError } from 'graphql';
import { controllerKeyService } from '../../services/controller-key.js';
import { controllerService } from '../../services/controller.js';
import { commandService } from '../../services/command.js';
import type { AuthContext } from './auth.js';

export const controllerResolvers = {
  Query: {
    controllerKeys: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return controllerKeyService.findAllByUser(context.currentUser._id.toString());
    },
    controllers: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return controllerService.findAllByUser(context.currentUser._id.toString());
    },
    controller: async (_parent: unknown, args: { id: string }, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return controllerService.findById(args.id, context.currentUser._id.toString());
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
      return controllerKeyService.create(context.currentUser._id.toString(), args.input);
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
        context.currentUser._id.toString(),
        args.input.name,
      );
      if (!result) {
        throw new GraphQLError('Key not found');
      }
      return result;
    },
    revokeControllerKey: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const success = await controllerKeyService.revoke(args.id, context.currentUser._id.toString());
      if (success) {
        await commandService.sendShutdown(args.id);
      }
      return success;
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
        context.currentUser._id.toString(),
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
      const success = await controllerService.unbind(args.id, context.currentUser._id.toString());
      if (success) {
        await commandService.sendShutdown(args.id);
      }
      return success;
    },
  },
};
