import { GraphQLError } from 'graphql';
import { sessionService } from '../../services/session.js';
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
      args: { sessionId: string; limit?: number; offset?: number },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return sessionService.getMessages(
        args.sessionId,
        context.currentUser.id,
        args.limit,
        args.offset,
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
  },
  Mutation: {
    createSession: async (
      _parent: unknown,
      args: { input: { controllerId: string; acpServerType: string; cwd?: string } },
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
  },
};