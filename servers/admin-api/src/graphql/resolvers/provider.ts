import { GraphQLError } from 'graphql';
import { providerService, PROVIDER_CONNECTIVITY_ERROR } from '../../services/provider.js';
import { notifyModelConfigChanged } from '../../services/model-push-notifier.js';
import { modelService } from '../../services/model.js';
import { assertAdmin } from './guard.js';
import type { AdminAuthContext } from './auth.js';

function mapProviderError(err: unknown): never {
  const message = (err as Error).message;
  if (message.includes('E11000')) {
    throw new GraphQLError('Provider name already exists');
  }
  if (message === PROVIDER_CONNECTIVITY_ERROR) {
    throw new GraphQLError(PROVIDER_CONNECTIVITY_ERROR);
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
        const result = await providerService.create(args.input as {
          name: string; type: 'OpenAI' | 'Anthropic'; endpoint: string; credentialType: string; credentialValue: string;
        });
        // fire-and-forget：通知 agent-api 全量下发（内部吞错，不影响 mutation 成功语义）
        void notifyModelConfigChanged();
        return result;
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
        void notifyModelConfigChanged();
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
      const result = await providerService.delete(args.id);
      // 未命中（非法/不存在）视为失败路径：零下发副作用
      if (result) void notifyModelConfigChanged();
      return result;
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
      void notifyModelConfigChanged();
      return result;
    },
    batchEnableGlobalProviders: async (
      _parent: unknown,
      args: { ids: string[] },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const result = await providerService.batchEnable(args.ids);
      void notifyModelConfigChanged();
      return result;
    },
    batchDisableGlobalProviders: async (
      _parent: unknown,
      args: { ids: string[] },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const result = await providerService.batchDisable(args.ids);
      void notifyModelConfigChanged();
      return result;
    },
    batchDeleteGlobalProviders: async (
      _parent: unknown,
      args: { ids: string[] },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const result = await providerService.batchDelete(args.ids);
      void notifyModelConfigChanged();
      return result;
    },
  },
  Provider: {
    models: async (parent: { id: string }) => {
      return modelService.findByProviderId(parent.id);
    },
  },
};
