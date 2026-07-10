import { GraphQLError } from 'graphql';
import { githubService } from '../../services/github.js';
import { getRedisClient } from '../../middleware/redis.js';
import type { AuthContext } from './auth.js';

export const githubResolvers = {
  Query: {
    githubAccounts: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) throw new GraphQLError('Not authenticated');
      return githubService.getAccounts(context.currentUser.id);
    },
    githubAppUrl: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) throw new GraphQLError('Not authenticated');
      const { url, state } = await githubService.getAppUrl(context.currentUser.id);
      const redis = getRedisClient();
      await redis.set(`github:oauth:state:${state}`, context.currentUser.id, 'EX', 600);
      return { url, state };
    },
  },
  Mutation: {
    unbindGitHubAccount: async (_parent: unknown, args: { accountId: string }, context: AuthContext) => {
      if (!context.currentUser) throw new GraphQLError('Not authenticated');
      return githubService.unbindAccount(context.currentUser.id, args.accountId);
    },
    refreshGitHubInstallations: async (_parent: unknown, args: { accountId: string }, context: AuthContext) => {
      if (!context.currentUser) throw new GraphQLError('Not authenticated');
      return githubService.refreshInstallations(context.currentUser.id, args.accountId);
    },
  },
};
