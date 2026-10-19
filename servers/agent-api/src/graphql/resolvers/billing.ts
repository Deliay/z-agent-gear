import { GraphQLError } from 'graphql';
import {
  billingClient,
  BillingServiceUnavailableError,
  type BillingAccountWire,
} from '../../services/billing-client.js';
import type { AuthContext } from './auth.js';

function requireUser(context: AuthContext): { id: string; username: string } {
  if (!context.currentUser) {
    throw new GraphQLError('Not authenticated', { extensions: { code: 'UNAUTHENTICATED' } });
  }
  return context.currentUser;
}

/** C2：按上游状态码映射稳定 GraphQL 错误码（400 参数错误不再误标 BILLING_UNAVAILABLE）。 */
function toGraphQLError(err: unknown): GraphQLError {
  if (err instanceof GraphQLError) return err;
  const status = err instanceof BillingServiceUnavailableError ? err.httpStatus : undefined;
  const message = err instanceof Error ? err.message : '费用服务请求失败';
  const code = status === 400 ? 'BAD_REQUEST' : status === 404 ? 'NOT_FOUND' : 'BILLING_UNAVAILABLE';
  return new GraphQLError(message, { extensions: { code } });
}

/** P2：统一包裹 resolver —— 所有上游调用错误都经 `toGraphQLError` 稳定映射（含 BAD_REQUEST/NOT_FOUND）。 */
async function run<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (err) {
    throw toGraphQLError(err);
  }
}

async function myAccount(context: AuthContext): Promise<BillingAccountWire> {
  const user = requireUser(context);
  return run(() => billingClient.getAccount('front_user', user.id, user.username));
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
    ) =>
      run(async () => {
        const account = await myAccount(context);
        return billingClient.listInvoices(account.id, args);
      }),
    myBillingReceipts: async (
      _parent: unknown,
      args: { page?: number; pageSize?: number },
      context: AuthContext,
    ) =>
      run(async () => {
        const account = await myAccount(context);
        return billingClient.listReceipts(account.id, args);
      }),
    myBillingReceipt: async (
      _parent: unknown,
      args: { invoiceId: string },
      context: AuthContext,
    ) =>
      run(async () => {
        const account = await myAccount(context);
        return billingClient.getReceiptByInvoice(account.id, args.invoiceId);
      }),
    myBillingRollups: async (
      _parent: unknown,
      args: { granularity: 'minute' | 'hour' | 'day'; from: string; to: string },
      context: AuthContext,
    ) =>
      run(async () => {
        const account = await myAccount(context);
        return billingClient.listRollups(account.id, args.granularity, args.from, args.to);
      }),
    myBillingApiKeys: async (_parent: unknown, _args: unknown, context: AuthContext) =>
      run(async () => {
        const user = requireUser(context);
        return billingClient.listApiKeys('front_user', user.id);
      }),
    myBillingApiCalls: async (
      _parent: unknown,
      args: { status?: string; page?: number; pageSize?: number },
      context: AuthContext,
    ) =>
      run(async () => {
        const account = await myAccount(context);
        return billingClient.listApiCalls(account.id, args);
      }),
  },
  Mutation: {
    createMyBillingApiKey: async (
      _parent: unknown,
      args: { name: string },
      context: AuthContext,
    ) =>
      run(async () => {
        const user = requireUser(context);
        return billingClient.createApiKey('front_user', user.id, args.name);
      }),
    revokeMyBillingApiKey: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) =>
      run(async () => {
        const user = requireUser(context);
        const result = await billingClient.revokeApiKey(args.id, 'front_user', user.id);
        return result.apiKey;
      }),
  },
};
