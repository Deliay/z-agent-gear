import { GraphQLError } from 'graphql';
import { gatewayService } from '../../services/gateway.js';
import { config } from '../../config/index.js';
import type { AuthContext } from './auth.js';

export const gatewayResolvers = {
  Query: {
    gateways: async (_parent: unknown, args: { controllerId: string }, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return gatewayService.findAllByController(args.controllerId, context.currentUser.id);
    },
  },
  Mutation: {
    createGateway: async (
      _parent: unknown,
      args: { controllerId: string; name: string; port: number },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await gatewayService.create(
          args.controllerId,
          context.currentUser.id,
          args.name,
          args.port,
          config.gatewayMaxPerController,
        );
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
    deleteGateway: async (
      _parent: unknown,
      args: { controllerId: string; name: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return gatewayService.delete(args.controllerId, context.currentUser.id, args.name);
    },
  },
};
