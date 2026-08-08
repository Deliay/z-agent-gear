import { GraphQLError } from 'graphql';
import type { Types } from 'mongoose';
import { McpServer, type IMcpServer } from '../../models/mcp-server.js';
import type { AuthContext } from './auth.js';

type McpServerDoc = IMcpServer & { _id: Types.ObjectId };

type McpServerResult = {
  id: string;
  name: string;
  transport: string;
  source: string;
  enabled: boolean;
  command: string | null | undefined;
  url: string | null | undefined;
  hostname: string | null | undefined;
  status: string;
  tools: { name: string; description: string | null | undefined }[];
  toolsSyncedAt: Date | null | undefined;
  lastHeartbeatAt: Date | null | undefined;
  createdAt: Date;
  updatedAt: Date;
};

function mapMcpServer(s: McpServerDoc): McpServerResult {
  return {
    id: s._id.toString(),
    name: s.name,
    transport: s.transport,
    source: s.source,
    enabled: s.enabled,
    command: s.command,
    url: s.url,
    hostname: s.hostname,
    status: s.status,
    tools: (s.tools ?? []).map(t => ({ name: t.name ?? '', description: t.description })),
    toolsSyncedAt: s.toolsSyncedAt,
    lastHeartbeatAt: s.lastHeartbeatAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export const mcpServerResolvers = {
  Query: {
    mcpServers: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const servers = await McpServer.find({ userId: context.currentUser.id }).sort({ createdAt: -1 }).lean();
      return servers.map(mapMcpServer);
    },
    mcpServer: async (_parent: unknown, { id }: { id: string }, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const server = await McpServer.findOne({ _id: id, userId: context.currentUser.id }).lean();
      return server ? mapMcpServer(server) : null;
    },
  },
  Mutation: {
    setMcpServerEnabled: async (
      _parent: unknown,
      { id, enabled }: { id: string; enabled: boolean },
      context: AuthContext,
    ) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const server = await McpServer.findOneAndUpdate(
        { _id: id, userId: context.currentUser.id },
        { $set: { enabled } },
        { new: true },
      ).lean();
      if (!server) {
        throw new GraphQLError('Server not found');
      }
      return mapMcpServer(server);
    },
  },
};
