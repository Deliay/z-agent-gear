import { GraphQLError } from 'graphql';
import { runWithLogContext } from '../../observability/log-context.js';
import {
  cloudHostSpecService,
  type AdminCloudSpecInput,
} from '../../services/cloud-host-spec.js';
import { assertAdmin } from './guard.js';
import type { AdminAuthContext } from './auth.js';

/** 契约错误文案白名单（逐字透传；未命中收敛 internal error）。 */
const SPEC_ERROR_MESSAGES = new Set([
  'name is required',
  'name is too long',
  'spec name already exists',
  'invalid spec resources',
  'invalid tenant in whitelist',
  'spec not found',
]);

function toSpecGraphQLError(err: unknown): never {
  if (err instanceof GraphQLError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (SPEC_ERROR_MESSAGES.has(message)) throw new GraphQLError(message);
  throw new GraphQLError('internal error');
}

export const cloudHostSpecResolvers = {
  Query: {
    adminCloudSpecs: async (_parent: unknown, _args: unknown, context: AdminAuthContext) => {
      assertAdmin(context);
      return runWithLogContext({ userId: context.currentAdmin!.id }, () =>
        cloudHostSpecService.list(),
      );
    },
    adminCloudSpec: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      return runWithLogContext({ userId: context.currentAdmin!.id }, () =>
        cloudHostSpecService.get(args.id),
      );
    },
  },
  Mutation: {
    adminCreateCloudSpec: async (
      _parent: unknown,
      args: { input: AdminCloudSpecInput },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        return await runWithLogContext({ userId: context.currentAdmin!.id }, () =>
          cloudHostSpecService.create(args.input),
        );
      } catch (err) {
        toSpecGraphQLError(err);
      }
    },
    adminUpdateCloudSpec: async (
      _parent: unknown,
      args: { id: string; input: AdminCloudSpecInput },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        return await runWithLogContext({ userId: context.currentAdmin!.id }, () =>
          cloudHostSpecService.update(args.id, args.input),
        );
      } catch (err) {
        toSpecGraphQLError(err);
      }
    },
    adminDeleteCloudSpec: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      return runWithLogContext({ userId: context.currentAdmin!.id }, () =>
        cloudHostSpecService.delete(args.id),
      );
    },
  },
};
