import { GraphQLError } from 'graphql';
import { McpServer } from '../../models/mcp-server.js';
import type { AuthContext } from './auth.js';

export const mcpServerResolvers = {
  Query: {
    mcpServers: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return McpServer.find({ userId: context.currentUser.id }).sort({ createdAt: -1 });
    },
    mcpServer: async (_parent: unknown, { id }: { id: string }, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return McpServer.findOne({ _id: id, userId: context.currentUser.id });
    },
  },
};
