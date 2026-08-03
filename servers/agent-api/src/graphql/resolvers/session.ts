import { GraphQLError } from 'graphql';
import { sessionService } from '../../services/session.js';
import { sessionImportService } from '../../services/session-import.js';
import { Controller } from '../../models/controller.js';
import type { AuthContext } from './auth.js';

export const sessionResolvers = {
  Query: {
    sessions: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.findAllByUser(context.currentUser.id);
    },
    session: async (_parent: unknown, args: { id: string }, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.findById(args.id, context.currentUser.id);
    },
    sessionMessages: async (
      _parent: unknown,
      args: { sessionId: string; before?: string; limit?: number },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.getMessages(
        args.sessionId,
        context.currentUser.id,
        { before: args.before, limit: args.limit },
      );
    },
    acpCapabilities: async (
      _parent: unknown,
      args: { controllerId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.getAcpCapabilities(args.controllerId, context.currentUser.id);
    },
    listHistorySessions: async (
      _parent: unknown,
      args: { controllerId: string; workspaceId: string; acpServerType?: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await sessionImportService.listHistorySessions(
          context.currentUser.id,
          args.controllerId,
          args.workspaceId,
          args.acpServerType ?? 'opencode',
        );
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
  },
  Mutation: {
    createSession: async (
      _parent: unknown,
      args: { input: { controllerId: string; acpServerType: string; workspaceId: string; enableWorktree?: boolean; worktreeBranchSuffix?: string; mcpServerIds?: string[] } },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        const session = await sessionService.create(context.currentUser.id, args.input);
        return { session };
      } catch (err) {
        if ((err as Error).message === 'Controller not found') {
          throw new GraphQLError('Controller not found');
        }
        if ((err as Error).message === 'Workspace not found') {
          throw new GraphQLError('Workspace not found');
        }
        throw new GraphQLError((err as Error).message);
      }
    },
    closeSession: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.close(args.id, context.currentUser.id);
    },
    deleteSession: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.delete(args.id, context.currentUser.id);
    },
    sendSessionMessage: async (
      _parent: unknown,
      args: { sessionId: string; content: string; type: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      // Verify session belongs to user
      const session = await sessionService.findById(args.sessionId, context.currentUser.id);
      if (!session) {
        throw new GraphQLError('Session not found');
      }
      return sessionService.addMessage(args.sessionId, {
        direction: 'input',
        type: args.type,
        content: args.content,
      });
    },
    cancelGeneration: async (
      _parent: unknown,
      args: { sessionId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.cancelGeneration(args.sessionId, context.currentUser.id);
    },
    resumeSession: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.resume(args.id, context.currentUser.id);
    },
    setSessionMode: async (
      _parent: unknown,
      args: { sessionId: string; modeId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.setMode(args.sessionId, context.currentUser.id, args.modeId);
    },
    setSessionModel: async (
      _parent: unknown,
      args: { sessionId: string; modelId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.setModel(args.sessionId, context.currentUser.id, args.modelId);
    },
    setSessionConfigOption: async (
      _parent: unknown,
      args: { sessionId: string; configId: string; value: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.setConfigOption(args.sessionId, context.currentUser.id, args.configId, args.value);
    },
    importHistorySessions: async (
      _parent: unknown,
      args: { controllerId: string; workspaceId: string; acpServerType?: string; sessionIds: string[] },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        const controller = await Controller.findOne({ _id: args.controllerId, userId: context.currentUser.id }).lean();
        const controllerName = controller?.name || 'Unknown';

        return await sessionImportService.importSessions(
          context.currentUser.id,
          args.controllerId,
          controllerName,
          args.workspaceId,
          args.sessionIds,
          args.acpServerType ?? 'opencode',
        );
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
    refreshAcpCapabilities: async (
      _parent: unknown,
      args: { controllerId: string },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      try {
        return await sessionService.refreshAcpCapabilities(args.controllerId, context.currentUser.id);
      } catch (err) {
        throw new GraphQLError((err as Error).message);
      }
    },
  },
};