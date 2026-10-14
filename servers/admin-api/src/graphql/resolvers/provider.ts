import { GraphQLError } from 'graphql';
import { providerService } from '../../services/provider.js';
import { modelService } from '../../services/model.js';
import { assertAdmin } from './guard.js';
import type { AdminAuthContext } from './auth.js';

function mapProviderError(err: unknown): never {
  const message = (err as Error).message;
  if (message.includes('E11000')) {
    throw new GraphQLError('Provider name already exists');
  }
  if (message.includes('connect') || message.includes('ECONN')) {
    throw new GraphQLError('供应商连通性测试失败，请检查 API 地址和凭据是否正确');
  }
  throw new GraphQLError(message);
}

export const providerResolvers = {
  Query: {
    adminProviders: async (_parent: unknown, _args: unknown, context: AdminAuthContext) => {
      assertAdmin(context);
      return providerService.findAll();
    },
  },
  Mutation: {
    createGlobalProvider: async (
      _parent: unknown,
      args: { input: { name: string; type: string; endpoint: string; credentialType: string; credentialValue: string } },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        return await providerService.create(args.input as {
          name: string; type: 'OpenAI' | 'Anthropic'; endpoint: string; credentialType: string; credentialValue: string;
        });
      } catch (err) {
        mapProviderError(err);
      }
    },
    updateGlobalProvider: async (
      _parent: unknown,
      args: { id: string; input: { name: string; type: string; endpoint: string; credentialType: string; credentialValue: string } },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        const result = await providerService.update(args.id, args.input as {
          name: string; type: 'OpenAI' | 'Anthropic'; endpoint: string; credentialType: string; credentialValue: string;
        });
        if (!result) {
          throw new GraphQLError('Provider not found');
        }
        return result;
      } catch (err) {
        if (err instanceof GraphQLError) throw err;
        mapProviderError(err);
      }
    },
    deleteGlobalProvider: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      return providerService.delete(args.id);
    },
    toggleGlobalProvider: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const result = await providerService.toggle(args.id);
      if (!result) {
        throw new GraphQLError('Provider not found');
      }
      return result;
    },
    batchEnableGlobalProviders: async (
      _parent: unknown,
      args: { ids: string[] },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      return providerService.batchEnable(args.ids);
    },
    batchDisableGlobalProviders: async (
      _parent: unknown,
      args: { ids: string[] },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      return providerService.batchDisable(args.ids);
    },
    batchDeleteGlobalProviders: async (
      _parent: unknown,
      args: { ids: string[] },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      return providerService.batchDelete(args.ids);
    },
  },
  Provider: {
    models: async (parent: { id: string }) => {
      return modelService.findByProviderId(parent.id);
    },
  },
};
