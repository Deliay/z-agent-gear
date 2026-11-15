import { GraphQLError } from 'graphql';
import {
  authProviderService,
  type GithubOauthInput,
  type OidcProviderInput,
} from '../../services/auth-provider.js';
import { assertAdmin } from './guard.js';
import type { AdminAuthContext } from './auth.js';

function mapError(err: unknown): never {
  if (err instanceof GraphQLError) throw err;
  const message = (err as Error).message;
  if ((err as { code?: number }).code === 11000) {
    throw new GraphQLError('配置已存在');
  }
  throw new GraphQLError(message);
}

export const authProviderResolvers = {
  Query: {
    oidcProviders: async (_parent: unknown, _args: unknown, context: AdminAuthContext) => {
      assertAdmin(context);
      return authProviderService.listOidcProviders();
    },
    githubOauthConfig: async (_parent: unknown, _args: unknown, context: AdminAuthContext) => {
      assertAdmin(context);
      return authProviderService.getGithubConfig();
    },
  },
  Mutation: {
    createOidcProvider: async (
      _parent: unknown,
      args: { input: OidcProviderInput },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        return await authProviderService.createOidcProvider(args.input);
      } catch (err) {
        mapError(err);
      }
    },
    updateOidcProvider: async (
      _parent: unknown,
      args: { id: string; input: OidcProviderInput },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        const updated = await authProviderService.updateOidcProvider(args.id, args.input);
        if (!updated) throw new GraphQLError('OIDC Provider not found');
        return updated;
      } catch (err) {
        mapError(err);
      }
    },
    deleteOidcProvider: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      return authProviderService.deleteOidcProvider(args.id);
    },
    upsertGithubOauthConfig: async (
      _parent: unknown,
      args: { input: GithubOauthInput },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        return await authProviderService.upsertGithubConfig(args.input);
      } catch (err) {
        mapError(err);
      }
    },
  },
};
