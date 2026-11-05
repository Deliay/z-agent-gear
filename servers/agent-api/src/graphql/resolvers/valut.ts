import { GraphQLError } from 'graphql';
import { valutService, type ValutEntryView, type ValutNamespaceGroupView } from '../../services/valut-service.js';
import type { AuthContext } from './auth.js';

/**
 * Valut GraphQL resolvers（契约 `contracts/valut.graphql`）。
 *
 * - 未认证统一 `Not authenticated`（GraphQLError 直接透传）；
 * - 业务错误经 `wrap()` **白名单逐字透传**（契约错误表），非白名单一律收敛
 *   `internal error`——不泄露驱动/实现细节，也不让任何 value 明文进入错误信息；
 * - 本文件不引用解密入口（明文不出服务端；单测扫描本目录断言）。
 */

/** 契约错误口径白名单（逐字透传）。 */
const VALUT_PUBLIC_ERRORS = new Set([
  'valut entry not found',
  'valut key already exists',
  'invalid valut key',
  'invalid valut value',
  'valut entry is not editable',
  'valut entry is not deletable',
  'valut entry has refs',
  'global workspace is read-only',
  'Not found',
]);

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GraphQLError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (VALUT_PUBLIC_ERRORS.has(message)) throw new GraphQLError(message);
    throw new GraphQLError('internal error');
  }
}

function requireUser(context: AuthContext): string {
  if (!context.currentUser) throw new GraphQLError('Not authenticated');
  return context.currentUser.id;
}

export const valutResolvers = {
  Query: {
    valutEntries: async (
      _parent: unknown,
      _args: unknown,
      context: AuthContext,
    ): Promise<ValutNamespaceGroupView[]> => {
      requireUser(context);
      return wrap(() => valutService.listGrouped());
    },
    valutManualOptions: async (
      _parent: unknown,
      _args: unknown,
      context: AuthContext,
    ): Promise<ValutEntryView[]> => {
      requireUser(context);
      return wrap(() => valutService.listManualOptions());
    },
  },
  Mutation: {
    createValutEntry: async (
      _parent: unknown,
      args: { input: { key: string; value: string } },
      context: AuthContext,
    ): Promise<ValutEntryView> => {
      const userId = requireUser(context);
      return wrap(() =>
        valutService.createManualEntry({
          key: args.input.key,
          value: args.input.value,
          createdBy: userId,
        }),
      );
    },
    updateValutEntry: async (
      _parent: unknown,
      args: { id: string; value: string },
      context: AuthContext,
    ): Promise<ValutEntryView> => {
      requireUser(context);
      return wrap(() => valutService.updateValue(args.id, args.value));
    },
    deleteValutEntry: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ): Promise<boolean> => {
      requireUser(context);
      return wrap(() => valutService.deleteEntry(args.id));
    },
  },
};
