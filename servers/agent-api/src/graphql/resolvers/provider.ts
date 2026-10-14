import { GraphQLError } from 'graphql';
import { providerService } from '../../services/provider.js';
import { rethrowAsGraphQLError } from './errors.js';
import type { AuthContext } from './auth.js';

const PROVIDER_ERROR_MAPPINGS: Array<[string, string]> = [
  ['E11000', 'Provider name already exists'],
  ['connect', '供应商连通性测试失败，请检查 API 地址和凭据是否正确'],
];

export const providerResolvers = {
  Query: {
    providers: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return providerService.findAll();
    },
  },
  Mutation: {
    createProvider: async (
      _parent: unknown,
      args: { input: { name: string; type: string; endpoint: string; credentialType: string; credentialValue: string } },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await providerService.create(args.input as { name: string; type: 'OpenAI' | 'Anthropic'; endpoint: string; credentialType: string; credentialValue: string });
      } catch (err) {
        rethrowAsGraphQLError(err, PROVIDER_ERROR_MAPPINGS);
      }
    },
    updateProvider: async (
      _parent: unknown,
      args: { id: string; input: { name: string; type: string; endpoint: string; credentialType: string; credentialValue: string } },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        const result = await providerService.update(args.id, args.input as { name: string; type: 'OpenAI' | 'Anthropic'; endpoint: string; credentialType: string; credentialValue: string });
        if (!result) {
          throw new GraphQLError('Provider not found');
        }
        return result;
      } catch (err) {
        rethrowAsGraphQLError(err, PROVIDER_ERROR_MAPPINGS);
      }
    },
    deleteProvider: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await providerService.delete(args.id);
      } catch (err) {
        rethrowAsGraphQLError(err);
      }
    },
    toggleProvider: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        const result = await providerService.toggle(args.id);
        if (!result) {
          throw new GraphQLError('Provider not found');
        }
        return result;
      } catch (err) {
        rethrowAsGraphQLError(err);
      }
    },
    batchEnableProviders: async (
      _parent: unknown,
      args: { ids: string[] },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await providerService.batchEnable(args.ids);
      } catch (err) {
        rethrowAsGraphQLError(err);
      }
    },
    batchDisableProviders: async (
      _parent: unknown,
      args: { ids: string[] },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await providerService.batchDisable(args.ids);
      } catch (err) {
        rethrowAsGraphQLError(err);
      }
    },
    batchDeleteProviders: async (
      _parent: unknown,
      args: { ids: string[] },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await providerService.batchDelete(args.ids);
      } catch (err) {
        rethrowAsGraphQLError(err);
      }
    },
  },
  Provider: {
    models: async (parent: { id: string }) => {
      const { modelService } = await import('../../services/model.js');
      return modelService.findByProviderId(parent.id);
    },
  },
};
