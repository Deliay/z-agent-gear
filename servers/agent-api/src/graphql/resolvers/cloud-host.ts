import { GraphQLError } from 'graphql';
import { Session } from '../../models/session.js';
import { CloudHost } from '../../models/cloud-host.js';
import {
  cloudHostService,
  toCloudHostGraphQLError,
} from '../../services/cloud-host-service.js';
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
