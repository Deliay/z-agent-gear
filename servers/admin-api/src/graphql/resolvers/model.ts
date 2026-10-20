import { GraphQLError } from 'graphql';
import { modelService } from '../../services/model.js';
import { modelRenameRecordService } from '../../services/model-rename-record.js';
import { providerService, PROVIDER_CONNECTIVITY_ERROR } from '../../services/provider.js';
import { assertAdmin } from './guard.js';
import type { AdminAuthContext } from './auth.js';

/**
 * 模型服务错误 → GraphQL 错误（统一出口）：
 * - 重名（含并发 E11000 兜底）→ `Model name already exists...`
 * - 上游连通性失败 → 既有中文文案
 * - 供应商不存在 / 非法模型名 → 原文
 */
function mapModelError(err: unknown): never {
  const message = (err as Error)?.message ?? 'Unknown error';
  if (message.includes('E11000')) {
    throw new GraphQLError('Model name already exists for this provider');
  }
  if (
    message.startsWith('Model name already exists') ||
    message === PROVIDER_CONNECTIVITY_ERROR ||
    message === 'Provider not found' ||
    message === 'Model name is invalid'
  ) {
    throw new GraphQLError(message);
  }
  throw new GraphQLError(message);
}

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
    listGlobalProviderModels: async (
      _parent: unknown,
      args: { providerId: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        return await modelService.listProviderModels(args.providerId);
      } catch (err) {
        mapModelError(err);
      }
    },
    modelRenameRecords: async (_parent: unknown, _args: unknown, context: AdminAuthContext) => {
      assertAdmin(context);
      return modelRenameRecordService.findAll();
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
        mapModelError(err);
      }
    },
    importGlobalModels: async (
      _parent: unknown,
      args: { providerId: string; names: string[] },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        return await modelService.importModels(args.providerId, args.names);
      } catch (err) {
        mapModelError(err);
      }
    },
    deleteGlobalModel: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const result = await modelService.delete(args.id);
      if (!result) {
        throw new GraphQLError('Model not found');
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
