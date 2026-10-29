import { GraphQLError } from 'graphql';
import { githubService } from '../../services/github.js';
import type { GitHubAccountInfo } from '../../services/github.js';
import {
  commitSettingsService,
  COMMIT_SETTINGS_ERRORS,
  type CommitSettingsInput,
} from '../../services/commit-settings-service.js';
import { getRedisClient } from '../../middleware/redis.js';
import { rethrowAsGraphQLError } from './errors.js';
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
      // 只读上下文（全局工作区 + developer）不得发起绑定（PRD：开发不能在全局工作区新增资源）
      if (context.workspaceAccess?.readOnly) {
        throw new GraphQLError('global workspace is read-only');
      }
      const { url, state } = await githubService.getAppUrl(context.currentUser.id);
      const redis = getRedisClient();
      // 多租户二期：state 携带发起绑定的工作区（OAuth 回调无请求上下文，需显式传递）
      await redis.set(
        `github:oauth:state:${state}`,
        JSON.stringify({
          userId: context.currentUser.id,
          workspaceId: context.workspaceAccess?.id ?? null,
        }),
        'EX',
        600,
      );
      return { url, state };
    },
  },
  Mutation: {
    unbindGitHubAccount: async (_parent: unknown, args: { accountId: string }, context: AuthContext) => {
      if (!context.currentUser) throw new GraphQLError('Not authenticated');
      try {
        return await githubService.unbindAccount(context.currentUser.id, args.accountId);
      } catch (err) {
        rethrowAsGraphQLError(err);
      }
    },
    refreshGitHubInstallations: async (_parent: unknown, args: { accountId: string }, context: AuthContext) => {
      if (!context.currentUser) throw new GraphQLError('Not authenticated');
      try {
        return await githubService.refreshInstallations(context.currentUser.id, args.accountId);
      } catch (err) {
        rethrowAsGraphQLError(err);
      }
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
        // 白名单文案原样透传（前端逐字映射）；只读红线与未知错误区分
        const whitelist = [
          ...(Object.values(COMMIT_SETTINGS_ERRORS) as string[]),
          'global workspace is read-only',
        ];
        const message = error instanceof Error ? error.message : '';
        throw new GraphQLError(
          whitelist.includes(message) ? message : 'invalid commit settings',
        );
      }
    },
  },
};
