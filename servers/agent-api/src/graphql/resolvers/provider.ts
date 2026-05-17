import { GraphQLError } from 'graphql';
import { providerService } from '../../services/provider.js';
import type { AuthContext } from './auth.js';

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
        if ((err as Error).message.includes('E11000')) {
          throw new GraphQLError('Provider name already exists');
        }
        if ((err as Error).message.includes('connect')) {
          throw new GraphQLError('供应商连通性测试失败，请检查 API 地址和凭据是否正确');
        }
        throw new GraphQLError((err as Error).message);
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
        if ((err as Error).message.includes('E11000')) {
          throw new GraphQLError('Provider name already exists');
        }
        if ((err as Error).message.includes('connect')) {
          throw new GraphQLError('供应商连通性测试失败，请检查 API 地址和凭据是否正确');
        }
        throw new GraphQLError((err as Error).message);
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
      return providerService.delete(args.id);
    },
    toggleProvider: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const result = await providerService.toggle(args.id);
      if (!result) {
        throw new GraphQLError('Provider not found');
      }
      return result;
    },
    batchEnableProviders: async (
      _parent: unknown,
      args: { ids: string[] },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return providerService.batchEnable(args.ids);
    },
    batchDisableProviders: async (
      _parent: unknown,
      args: { ids: string[] },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return providerService.batchDisable(args.ids);
    },
    batchDeleteProviders: async (
      _parent: unknown,
      args: { ids: string[] },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return providerService.batchDelete(args.ids);
    },
  },
  Provider: {
    models: async (parent: { id: string }) => {
      const { modelService } = await import('../../services/model.js');
      return modelService.findByProviderId(parent.id);
    },
  },
};
