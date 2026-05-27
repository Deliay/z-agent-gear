import { GraphQLError } from 'graphql';
import { portForwardService } from '../../services/port-forward.js';
import { config } from '../../config/index.js';
import type { AuthContext } from './auth.js';

export const portForwardResolvers = {
  Query: {
    portForwards: async (_parent: unknown, args: { controllerId: string }, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return portForwardService.findAllByController(args.controllerId, context.currentUser.id);
    },
  },
  Mutation: {
    createPortForward: async (
      _parent: unknown,
      args: { controllerId: string; port: number },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await portForwardService.create(
          args.controllerId,
          context.currentUser.id,
          args.port,
          config.portForwardMaxPerController,
        );
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
    deletePortForward: async (
      _parent: unknown,
      args: { controllerId: string; port: number },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return portForwardService.delete(args.controllerId, context.currentUser.id, args.port);
    },
  },
};
