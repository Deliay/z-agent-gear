import { McpServer } from '../../models/mcp-server.js';

export const mcpServerResolvers = {
  Query: {
    mcpServers: async (_parent: unknown, _args: unknown, context: { userId: string }) => {
      return McpServer.find({ userId: context.userId }).sort({ createdAt: -1 });
    },
    mcpServer: async (_parent: unknown, { id }: { id: string }, context: { userId: string }) => {
      return McpServer.findOne({ _id: id, userId: context.userId });
    },
  },
};
