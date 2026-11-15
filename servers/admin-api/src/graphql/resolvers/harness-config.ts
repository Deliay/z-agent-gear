import { GraphQLError } from 'graphql';
import { harnessConfigService } from '../../services/harness-config.js';
import type { HarnessConfigType } from '../../models/harness-config.js';
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

export const harnessConfigResolvers = {
  Query: {
    adminHarnessConfigs: async (
      _parent: unknown,
      _args: unknown,
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        return await harnessConfigService.listConfigs();
      } catch (err) {
        mapError(err);
      }
    },
  },
  Mutation: {
    upsertHarnessConfig: async (
      _parent: unknown,
      args: { harnessType: HarnessConfigType; compactCommand: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        return await harnessConfigService.upsertConfig(args.harnessType, args.compactCommand);
      } catch (err) {
        mapError(err);
      }
    },
  },
};
