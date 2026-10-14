import { GraphQLError } from 'graphql';
import { baseImageService } from '../../services/base-image.js';
import { assertAdmin } from './guard.js';
import type { AdminAuthContext } from './auth.js';

function isDuplicateKeyError(err: unknown): boolean {
  return (err as Error).message.includes('E11000');
}

export const baseImageResolvers = {
  Query: {
    baseImages: async (_parent: unknown, _args: unknown, context: AdminAuthContext) => {
      assertAdmin(context);
      return baseImageService.list();
    },
    baseImage: async (_parent: unknown, args: { id: string }, context: AdminAuthContext) => {
      assertAdmin(context);
      return baseImageService.get(args.id);
    },
  },
  Mutation: {
    createBaseImage: async (
      _parent: unknown,
      args: { input: { name: string; description?: string; dockerfile: string } },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        return await baseImageService.create(args.input);
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw new GraphQLError('Base image name already exists');
        }
        throw new GraphQLError((err as Error).message);
      }
    },
    updateBaseImage: async (
      _parent: unknown,
      args: { id: string; input: { name: string; description?: string; dockerfile: string } },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        const result = await baseImageService.update(args.id, args.input);
        if (!result) {
          throw new GraphQLError('Base image not found');
        }
        return result;
      } catch (err) {
        if (err instanceof GraphQLError) throw err;
        if (isDuplicateKeyError(err)) {
          throw new GraphQLError('Base image name already exists');
        }
        throw new GraphQLError((err as Error).message);
      }
    },
    deleteBaseImage: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      return baseImageService.delete(args.id);
    },
  },
};
