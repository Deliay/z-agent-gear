import { GraphQLError } from 'graphql';
import { modelService } from '../../services/model.js';
import { providerService } from '../../services/provider.js';
import { invalidateAcpOptionsForUser } from '../../services/acp-options-cache.js';
import { rethrowAsGraphQLError } from './errors.js';
import type { AuthContext } from './auth.js';

/** 模型增删改/启用停用后，尽力失效该用户的 ACP 选项缓存（失败只告警，不影响 mutation 返回）。 */
async function invalidateAcpOptionsBestEffort(userId: string): Promise<void> {
  try {
    await invalidateAcpOptionsForUser(userId);
  } catch (err) {
    console.warn('[model] invalidate acp options failed:', (err as Error).message);
  }
}

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
        const result = await modelService.createCustom(args.input);
        await invalidateAcpOptionsBestEffort(context.currentUser.id);
        return result;
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
        await invalidateAcpOptionsBestEffort(context.currentUser.id);
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
        await invalidateAcpOptionsBestEffort(context.currentUser.id);
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
    providerId: (parent: { providerId: string; scope?: string }) => {
      // global（后台/系统内置）模型的来源供应商属于平台内部信息：
      // 数据层一并掩蔽 providerId，避免前端按 id 反查后台供应商（PRD §1.3/§4.2）。
      return parent.scope === 'global' ? null : parent.providerId;
    },
    provider: async (parent: { providerId: string; scope?: string }) => {
      // global 模型不返回供应商摘要（连 name/type 都不暴露），统一由前台展示「系统内置」。
      if (parent.scope === 'global') return null;
      // user 模型的 providerId 可能悬空（关联供应商已删除）→ 返回 null；
      // 契约已将该字段声明为可空（ProviderSummary），避免非空违规打挂整条 models 查询（问题 51）。
      return providerService.findSummaryById(parent.providerId);
    },
  },
};
