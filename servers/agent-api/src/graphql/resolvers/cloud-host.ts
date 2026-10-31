import { GraphQLError } from 'graphql';
import mongoose from 'mongoose';
import { config } from '../../config/index.js';
import { logger as rootLogger } from '../../observability/logger.js';
import { Session } from '../../models/session.js';
import { CloudContainer } from '../../models/cloud-container.js';
import { CloudHost } from '../../models/cloud-host.js';
import { CloudHostSetupOperation } from '../../models/cloud-host-setup-operation.js';
import {
  cloudHostService,
  toCloudHostGraphQLError,
} from '../../services/cloud-host-service.js';
import {
  cloudHostWorkloadService,
  mapOperation,
  toCloudHostSetupGraphQLError,
} from '../../services/cloud-host-workload-service.js';
import { cloudHostGithubService } from '../../services/cloud-host-github-service.js';
import { billingClient } from '../../services/billing-client.js';
import {
  cloudHostIssuesLinkageService,
  type CloudHostIssuesLinkageInput,
} from '../../services/cloud-host-issues-linkage.js';
import type { AuthContext } from './auth.js';
import { actorFilter } from '../../services/workspace-context.js';

type Doc = Record<string, unknown>;

/** 报价降级默认值（价目档以 admin-api pricing.ts 为准）。 */
const FALLBACK_CREATE_CREDITS = 5;
const FALLBACK_PER_MINUTE_CREDITS = 1;

function requireUser(context: AuthContext): string {
  if (!context.currentUser) {
    throw new GraphQLError('Not authenticated');
  }
  return context.currentUser.id;
}

export const cloudHostResolvers = {
  Query: {
    cloudHostCapabilities: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      requireUser(context);
      return cloudHostService.getCapabilities();
    },
    myCloudHosts: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      const userId = requireUser(context);
      return cloudHostService.list(userId);
    },
    cloudHostBillingQuote: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      const userId = requireUser(context);
      const billingTenantId = context.workspaceAccess?.tenantId ?? context.currentUser?.tenantId ?? userId;
      let createCredits = FALLBACK_CREATE_CREDITS;
      let perMinuteCredits = FALLBACK_PER_MINUTE_CREDITS;
      let availableBalance: number | null = null;
      const [prices, account] = await Promise.allSettled([
        billingClient.getPriceQuote(['cloud_host.create', 'container.minute']),
        billingClient.getAccount('tenant', billingTenantId),
      ]);
      if (prices.status === 'fulfilled') {
        for (const item of prices.value) {
          if (item.productId === 'cloud_host.create') createCredits = item.unitPrice;
          if (item.productId === 'container.minute') perMinuteCredits = item.unitPrice;
        }
      } else {
        rootLogger.warn(
          { component: 'cloud-host', event: 'price-fallback', reason: prices.reason },
          'billing quote price fallback',
        );
      }
      if (account.status === 'fulfilled') {
        availableBalance = account.value.availableBalance;
      } else {
        rootLogger.warn(
          { component: 'cloud-host', event: 'balance-unavailable', reason: account.reason },
          'billing quote balance unavailable',
        );
      }
      return { createCredits, perMinuteCredits, availableBalance };
    },
    cloudHost: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      if (!mongoose.isValidObjectId(args.id)) return null;
      // 软删除仍返回（与 Session.cloudHost 留档口径一致）；不存在/非本工作区成员返回 null（成员口径）。
      const doc = await CloudHost.findOne({ _id: args.id, ...actorFilter(userId) }).lean();
      if (!doc) return null;
      const activeSessionCount = await Session.countDocuments({
        controllerId: doc.controllerId,
        ...actorFilter(userId),
        status: { $ne: 'ended' },
      });
      return cloudHostService.mapCloudHost(doc as Doc, activeSessionCount);
    },
    cloudHostStopImpact: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudHostService.stopImpact(args.id, userId);
      } catch (err) {
        toCloudHostGraphQLError(err);
      }
    },
    cloudHostWorkloads: async (
      _parent: unknown,
      args: { controllerId: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudHostWorkloadService.list(userId, args.controllerId);
      } catch (err) {
        toCloudHostSetupGraphQLError(err);
      }
    },
    cloudHostWorkloadCatalog: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      requireUser(context);
      try {
        return await cloudHostWorkloadService.listCatalog();
      } catch (err) {
        toCloudHostSetupGraphQLError(err);
      }
    },
    cloudHostSetupOperation: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      if (!mongoose.isValidObjectId(args.id)) return null;
      const doc = await CloudHostSetupOperation.findOne({ _id: args.id }).lean();
      if (!doc) return null;
      // 操作单无 workspaceId：经 host 的工作区归属校验（成员可操作本工作区资源）
      const hostVisible = await CloudHost.findOne({
        _id: doc.hostId,
        ...actorFilter(userId),
      })
        .select('_id')
        .lean();
      if (!hostVisible) return null;
      if (doc.status === 'RUNNING') {
        const updatedAt = doc.updatedAt instanceof Date ? doc.updatedAt.getTime() : 0;
        if (Date.now() - updatedAt > config.cloudHostSetupStaleMs) {
          await CloudHostSetupOperation.updateOne(
            { _id: args.id },
            {
              $set: {
                status: 'FAILED',
                error: '操作已中断，请重试',
                'steps.$[failed].status': 'FAILED',
              },
            },
            { arrayFilters: [{ 'failed.status': 'RUNNING' }] },
          ).catch(() => undefined);
          const refreshed = await CloudHostSetupOperation.findById(args.id).lean();
          return refreshed ? mapOperation(refreshed as Record<string, unknown>) : null;
        }
      }
      return mapOperation(doc as Record<string, unknown>);
    },
    cloudHostIssuesLinkages: async (
      _parent: unknown,
      args: { controllerId: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudHostIssuesLinkageService.list(userId, args.controllerId);
      } catch (err) {
        toCloudHostGraphQLError(err);
      }
    },
  },
  Mutation: {
    createCloudHost: async (
      _parent: unknown,
      args: { input: { name: string; harnessTypes: string[]; workloadIds?: string[]; createDefaultSession?: boolean | null; githubAccountId?: string | null } },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudHostService.create(userId, {
          name: args.input.name,
          harnessTypes: args.input.harnessTypes,
          workloadIds: args.input.workloadIds,
          githubAccountId: args.input.githubAccountId,
          ...(args.input.createDefaultSession === undefined || args.input.createDefaultSession === null
            ? {}
            : { createDefaultSession: args.input.createDefaultSession }),
        });
      } catch (err) {
        toCloudHostGraphQLError(err);
      }
    },
    stopCloudHost: async (
      _parent: unknown,
      args: { id: string; force?: boolean | null },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudHostService.stop(args.id, userId, args.force === true);
      } catch (err) {
        toCloudHostGraphQLError(err);
      }
    },
    deleteCloudHost: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudHostService.delete(args.id, userId);
      } catch (err) {
        toCloudHostGraphQLError(err);
      }
    },
    installCloudHostWorkload: async (
      _parent: unknown,
      args: { input: { controllerId: string; workloadId: string; params?: Record<string, unknown> } },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudHostWorkloadService.createInstallOperation({
          userId,
          controllerId: args.input.controllerId,
          workloadId: args.input.workloadId,
          params: args.input.params ?? undefined,
        });
      } catch (err) {
        toCloudHostSetupGraphQLError(err);
      }
    },
    setupCloudHostGithubProject: async (
      _parent: unknown,
      args: {
        input: {
          controllerId: string;
          accountId: string;
          repoFullName: string;
          targetPath: string;
          workloadIds?: string[];
          createSession?: boolean | null;
        };
      },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudHostGithubService.createOperation({
          userId,
          controllerId: args.input.controllerId,
          accountId: args.input.accountId,
          repoFullName: args.input.repoFullName,
          targetPath: args.input.targetPath,
          workloadIds: args.input.workloadIds,
          ...(args.input.createSession === undefined || args.input.createSession === null
            ? {}
            : { createSession: args.input.createSession }),
        });
      } catch (err) {
        toCloudHostSetupGraphQLError(err);
      }
    },
    retryCloudHostSetupOperation: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        const operation = await CloudHostSetupOperation.findOne({ _id: args.id }).lean();
        // 越界与不存在统一返回 Operation not found（不泄露存在性）
        if (!operation) throw new Error('Operation not found');
        // 操作单无 workspaceId：经 host 工作区归属校验（与详情口径一致）
        const hostVisible = await CloudHost.findOne({
          _id: (operation as unknown as { hostId: unknown }).hostId,
          ...actorFilter(userId),
        })
          .select('_id')
          .lean();
        if (!hostVisible) throw new Error('Operation not found');
        if (operation.kind === 'githubSetup') {
          return await cloudHostGithubService.retry(args.id, userId);
        }
        return await cloudHostWorkloadService.retryInstall(args.id, userId);
      } catch (err) {
        toCloudHostSetupGraphQLError(err);
      }
    },
    createCloudHostIssuesLinkage: async (
      _parent: unknown,
      args: { input: CloudHostIssuesLinkageInput },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudHostIssuesLinkageService.create(userId, args.input);
      } catch (err) {
        toCloudHostGraphQLError(err);
      }
    },
    updateCloudHostIssuesLinkage: async (
      _parent: unknown,
      args: { id: string; input: CloudHostIssuesLinkageInput },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudHostIssuesLinkageService.update(userId, args.id, args.input);
      } catch (err) {
        toCloudHostGraphQLError(err);
      }
    },
    deleteCloudHostIssuesLinkage: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudHostIssuesLinkageService.remove(userId, args.id);
      } catch (err) {
        toCloudHostGraphQLError(err);
      }
    },
    cleanupCloudHostIssuesLabels: async (
      _parent: unknown,
      args: { controllerId: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudHostIssuesLinkageService.cleanup(userId, args.controllerId);
      } catch (err) {
        toCloudHostGraphQLError(err);
      }
    },
  },
  CloudHost: {
    defaultWorkspace: async (parent: Doc) => cloudHostService.defaultWorkspace(parent),
    workloadInstalling: async (parent: Doc) => {
      const hostId = String(parent.id ?? '');
      if (!hostId) return null;
      const container = await CloudContainer.findOne({
        hostId,
        status: 'initializing',
      })
        .sort({ createdAt: -1 })
        .lean();
      return container?.currentWorkloadName ?? null;
    },
  },
  Controller: {
    cloudHost: async (parent: Doc, _args: unknown, context: AuthContext) => {
      const userId = context.currentUser?.id;
      if (!userId || parent.type !== 'cloud') return null;
      const host = await CloudHost.findOne({
        controllerId: String(parent.id),
        userId,
        deletedAt: null,
      }).lean();
      if (!host) return null;
      const activeSessionCount = await Session.countDocuments({
        controllerId: String(parent.id),
        userId,
        status: { $ne: 'ended' },
      });
      return cloudHostService.mapCloudHost(host as Doc, activeSessionCount);
    },
  },
};
