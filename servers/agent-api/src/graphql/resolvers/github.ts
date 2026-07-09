import { githubService } from '../../services/github.js';
import type { AuthContext } from './auth.js';

export const githubResolvers = {
  Query: {
    githubAccounts: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) throw new Error('Not authenticated');
      return githubService.getAccounts(context.currentUser.id);
    },
    githubAppUrl: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) throw new Error('Not authenticated');
      return githubService.getAppUrl(context.currentUser.id);
    },
  },
  Mutation: {
    unbindGitHubAccount: async (_parent: unknown, args: { accountId: string }, context: AuthContext) => {
      if (!context.currentUser) throw new Error('Not authenticated');
      return githubService.unbindAccount(context.currentUser.id, args.accountId);
    },
    refreshGitHubInstallations: async (_parent: unknown, args: { accountId: string }, context: AuthContext) => {
      if (!context.currentUser) throw new Error('Not authenticated');
      return githubService.refreshInstallations(context.currentUser.id, args.accountId);
    },
  },
};
