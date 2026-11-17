import { GraphQLError } from 'graphql';
import { logger as rootLogger } from '../../observability/logger.js';
import { modelService } from '../../services/model.js';
import { providerService } from '../../services/provider.js';
import { llmApiService, type ProviderType } from '../../services/llm-api.js';
import { invalidateAcpOptionsForUser } from '../../services/acp-options-cache.js';
import { pushModelProvisionForTenant } from '../../services/cloud-host-model-push.js';
import { rethrowAsGraphQLError } from './errors.js';
import type { AuthContext } from './auth.js';

/** 模型增删改/启用停用后，尽力失效该用户的 ACP 选项缓存（失败只告警，不影响 mutation 返回）。 */
async function invalidateAcpOptionsBestEffort(userId: string): Promise<void> {
  try {
    await invalidateAcpOptionsForUser(userId);
  } catch (err) {
    rootLogger.warn({ component: 'model', err }, 'invalidate acp options failed');
  }
}

/**
 * 用户侧模型/供应商变更成功后，尽力把最新模型清单实时下发到该租户运行中的云电脑。
 * fire-and-forget：失败只告警，不影响 mutation 返回（D3）。
 */
export function scheduleModelPush(context: AuthContext): void {
  const tenantId = context.tenantId ?? context.currentUser?.tenantId ?? context.currentUser?.id;
  if (!tenantId) return;
  void pushModelProvisionForTenant(tenantId).catch((err) => {
    rootLogger.warn({ component: 'model', tenantId, err }, 'push model provision failed');
  });
}

const PROVIDER_MODEL_OPTIONS_ERROR = '拉取供应商模型清单失败，请检查 API 地址和凭据是否正确';

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
    /**
     * 供应商上游模型清单（新增自定义模型时的上下文预填数据源）。
     * 不在服务端缓存（新鲜度优先，D16）；上游失败归一为可读文案，不泄漏上游细节。
     */
    providerModelOptions: async (
      _parent: unknown,
      args: { providerId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const connection = await providerService.getDecryptedConnection(args.providerId);
      if (!connection) {
        throw new GraphQLError('Provider not found');
      }
      try {
        return await llmApiService.fetchModelCatalog(
          connection.type as ProviderType,
          connection.endpoint,
          connection.apiKey,
        );
      } catch (err) {
        rootLogger.warn(
          { component: 'model', providerId: args.providerId, err },
          'fetch provider model catalog failed',
        );
        throw new GraphQLError(PROVIDER_MODEL_OPTIONS_ERROR);
      }
    },
  },
  Mutation: {
    createCustomModel: async (
      _parent: unknown,
      args: { input: { providerId: string; name: string; contextLength?: number | null } },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        const result = await modelService.createCustom(args.input);
        await invalidateAcpOptionsBestEffort(context.currentUser.id);
        scheduleModelPush(context);
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
        scheduleModelPush(context);
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
        scheduleModelPush(context);
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
        const result = await modelService.updateSortOrder(args.ids);
        await invalidateAcpOptionsBestEffort(context.currentUser.id);
        scheduleModelPush(context);
        return result;
      } catch (err) {
        rethrowAsGraphQLError(err);
      }
    },
    /** 编辑用户自有模型的上下文长度（null = 清空）；成功后失效 ACP 缓存并下发。 */
    updateModelContextLength: async (
      _parent: unknown,
      args: { modelId: string; contextLength?: number | null },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        const result = await modelService.updateContextLength(args.modelId, args.contextLength ?? null);
        await invalidateAcpOptionsBestEffort(context.currentUser.id);
        scheduleModelPush(context);
        return result;
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
