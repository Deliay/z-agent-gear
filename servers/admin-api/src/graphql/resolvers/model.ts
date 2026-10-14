import { GraphQLError } from 'graphql';
import { modelService } from '../../services/model.js';
import { providerService } from '../../services/provider.js';
import { assertAdmin } from './guard.js';
import type { AdminAuthContext } from './auth.js';

export const modelResolvers = {
  Query: {
    adminModels: async (_parent: unknown, _args: unknown, context: AdminAuthContext) => {
      assertAdmin(context);
      return modelService.findAll();
    },
    adminModelsByProvider: async (
      _parent: unknown,
      args: { providerId: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      return modelService.findByProviderId(args.providerId);
    },
  },
  Mutation: {
    createGlobalCustomModel: async (
      _parent: unknown,
      args: { input: { providerId: string; name: string } },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        return await modelService.createCustom(args.input);
      } catch (err) {
        if ((err as Error).message.includes('E11000')) {
          throw new GraphQLError('Model name already exists for this provider');
        }
        throw new GraphQLError((err as Error).message);
      }
    },
    deleteGlobalCustomModel: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const result = await modelService.delete(args.id);
      if (!result) {
        throw new GraphQLError('Model not found or is not a custom model');
      }
      return result;
    },
    toggleGlobalModel: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const result = await modelService.toggle(args.id);
      if (!result) {
        throw new GraphQLError('Model not found or its provider is disabled');
      }
      return result;
    },
    updateGlobalModelSortOrder: async (
      _parent: unknown,
      args: { ids: string[] },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      return modelService.updateSortOrder(args.ids);
    },
  },
  Model: {
    provider: async (parent: { providerId: string }) => {
      return providerService.findById(parent.providerId);
    },
  },
};
