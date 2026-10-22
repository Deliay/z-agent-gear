import { GraphQLError } from 'graphql';
import mongoose from 'mongoose';
import { config } from '../../config/index.js';
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
import type { AuthContext } from './auth.js';

type Doc = Record<string, unknown>;

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
    cloudHostSetupOperation: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      if (!mongoose.isValidObjectId(args.id)) return null;
      const doc = await CloudHostSetupOperation.findOne({ _id: args.id, userId }).lean();
      if (!doc) return null;
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
  },
  Mutation: {
    createCloudHost: async (
      _parent: unknown,
      args: { input: { name: string; harnessTypes: string[] } },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudHostService.create(userId, args.input);
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
        };
      },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudHostGithubService.createOperation({
          userId,
          ...args.input,
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
        const operation = await CloudHostSetupOperation.findOne({
          _id: args.id,
          userId,
        }).lean();
        if (!operation) throw new Error('Operation not found');
        if (operation.kind === 'githubSetup') {
          return await cloudHostGithubService.retry(args.id, userId);
        }
        return await cloudHostWorkloadService.retryInstall(args.id, userId);
      } catch (err) {
        toCloudHostSetupGraphQLError(err);
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
