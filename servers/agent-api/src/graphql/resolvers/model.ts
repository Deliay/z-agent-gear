import { GraphQLError } from 'graphql';
import { modelService } from '../../services/model.js';
import { providerService } from '../../services/provider.js';
import { rethrowAsGraphQLError } from './errors.js';
import type { AuthContext } from './auth.js';

export const modelResolvers = {
  Query: {
    models: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return modelService.findAll();
    },
    modelsByProvider: async (
      _parent: unknown,
      args: { providerId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return modelService.findByProviderId(args.providerId);
    },
  },
  Mutation: {
    createCustomModel: async (
      _parent: unknown,
      args: { input: { providerId: string; name: string } },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await modelService.createCustom(args.input);
      } catch (err) {
        rethrowAsGraphQLError(err, [
          ['E11000', 'Model name already exists for this provider'],
          ['Provider not found', 'Provider not found'],
        ]);
      }
    },
    deleteCustomModel: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        const result = await modelService.delete(args.id);
        if (!result) {
          throw new GraphQLError('Model not found or is not a custom model');
        }
        return result;
      } catch (err) {
        rethrowAsGraphQLError(err);
      }
    },
    toggleModel: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        const result = await modelService.toggle(args.id);
        if (!result) {
          throw new GraphQLError('Model not found or its provider is disabled');
        }
        return result;
      } catch (err) {
        rethrowAsGraphQLError(err);
      }
    },
    updateModelSortOrder: async (
      _parent: unknown,
      args: { ids: string[] },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await modelService.updateSortOrder(args.ids);
      } catch (err) {
        rethrowAsGraphQLError(err);
      }
    },
  },
  Model: {
    provider: async (parent: { providerId: string }) => {
      return providerService.findById(parent.providerId);
    },
  },
};
