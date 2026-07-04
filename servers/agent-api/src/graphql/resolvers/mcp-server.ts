import mongoose from 'mongoose';
import { GraphQLError } from 'graphql';
import { McpServer } from '../../models/mcp-server.js';
import type { AuthContext } from './auth.js';

export const mcpServerResolvers = {
  Query: {
    mcpServers: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const servers = await McpServer.find({ userId: context.currentUser.id }).sort({ createdAt: -1 }).lean();
      return servers.map(s => ({
        id: (s._id as mongoose.Types.ObjectId).toString(),
        name: s.name,
        transport: s.transport,
        command: s.command,
        status: s.status,
        lastHeartbeatAt: s.lastHeartbeatAt,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
    },
    mcpServer: async (_parent: unknown, { id }: { id: string }, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      return McpServer.findOne({ _id: id, userId: context.currentUser.id });
    },
  },
};
