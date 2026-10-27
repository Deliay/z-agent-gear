import { GraphQLError } from 'graphql';
import { githubService } from '../../services/github.js';
import type { GitHubAccountInfo } from '../../services/github.js';
import {
  commitSettingsService,
  COMMIT_SETTINGS_ERRORS,
  type CommitSettingsInput,
} from '../../services/commit-settings-service.js';
import { getRedisClient } from '../../middleware/redis.js';
import type { AuthContext } from './auth.js';

export const githubResolvers = {
  Query: {
    githubAccounts: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) throw new GraphQLError('Not authenticated');
      return githubService.getAccounts(context.currentUser.id);
    },
    commitSettings: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) throw new GraphQLError('Not authenticated');
      return commitSettingsService.getCommitSettings(context.currentUser.id);
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
    updateCommitSettings: async (
      _parent: unknown,
      args: { input: CommitSettingsInput },
      context: AuthContext,
    ) => {
      if (!context.currentUser) throw new GraphQLError('Not authenticated');
      try {
        return await commitSettingsService.updateCommitSettings(context.currentUser.id, args.input);
      } catch (error) {
        // 白名单文案原样透传（前端逐字映射）；未知错误不泄漏内部细节。
        const whitelist = Object.values(COMMIT_SETTINGS_ERRORS) as string[];
        const message = error instanceof Error ? error.message : '';
        throw new GraphQLError(
          whitelist.includes(message) ? message : 'invalid commit settings',
        );
      }
    },
  },
};
