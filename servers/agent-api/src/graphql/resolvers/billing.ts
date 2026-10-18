import { GraphQLError } from 'graphql';
import { billingClient, type BillingAccountWire } from '../../services/billing-client.js';
import type { AuthContext } from './auth.js';

function requireUser(context: AuthContext): { id: string; username: string } {
  if (!context.currentUser) {
    throw new GraphQLError('Not authenticated', { extensions: { code: 'UNAUTHENTICATED' } });
  }
  return context.currentUser;
}

async function myAccount(context: AuthContext): Promise<BillingAccountWire> {
  const user = requireUser(context);
  try {
    return await billingClient.getAccount('front_user', user.id, user.username);
  } catch (err) {
    throw new GraphQLError((err as Error).message, {
      extensions: { code: 'BILLING_UNAVAILABLE' },
    });
  }
}

/** 前台「我的费用」：只读 + API Key 管理；无充值 mutation（仅后台充值）。 */
export const billingResolvers = {
  Query: {
    myBillingAccount: async (_parent: unknown, _args: unknown, context: AuthContext) =>
      myAccount(context),
    myBillingInvoices: async (
      _parent: unknown,
      args: {
        from?: string;
        to?: string;
        type?: string;
        category?: string;
        page?: number;
        pageSize?: number;
      },
      context: AuthContext,
    ) => {
      const account = await myAccount(context);
      return billingClient.listInvoices(account.id, args);
    },
    myBillingReceipts: async (
      _parent: unknown,
      args: { page?: number; pageSize?: number },
      context: AuthContext,
    ) => {
      const account = await myAccount(context);
      return billingClient.listReceipts(account.id, args);
    },
    myBillingRollups: async (
      _parent: unknown,
      args: { granularity: 'minute' | 'hour' | 'day'; from: string; to: string },
      context: AuthContext,
    ) => {
      const account = await myAccount(context);
      return billingClient.listRollups(account.id, args.granularity, args.from, args.to);
    },
    myBillingApiKeys: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      const user = requireUser(context);
      return billingClient.listApiKeys('front_user', user.id);
    },
  },
  Mutation: {
    createMyBillingApiKey: async (
      _parent: unknown,
      args: { name: string },
      context: AuthContext,
    ) => {
      const user = requireUser(context);
      return billingClient.createApiKey('front_user', user.id, args.name);
    },
    revokeMyBillingApiKey: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      const user = requireUser(context);
      const result = await billingClient.revokeApiKey(args.id, 'front_user', user.id);
      return result.apiKey;
    },
  },
};
