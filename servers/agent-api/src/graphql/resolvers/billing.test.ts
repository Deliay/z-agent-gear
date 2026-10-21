import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';

vi.mock('../../services/billing-client.js', () => {
  class BillingServiceUnavailableError extends Error {
    code = 'BILLING_SERVICE_UNAVAILABLE';
    constructor(message: string, readonly httpStatus?: number) {
      super(message);
      this.name = 'BillingServiceUnavailableError';
    }
  }
  return {
    BillingServiceUnavailableError,
    billingClient: {
      getAccount: vi.fn(),
      listInvoices: vi.fn(),
      listReceipts: vi.fn(),
      getReceiptByInvoice: vi.fn(),
      listRollups: vi.fn(),
      listApiKeys: vi.fn(),
      listApiCalls: vi.fn(),
      createApiKey: vi.fn(),
      revokeApiKey: vi.fn(),
    },
  };
});

import { billingClient, BillingServiceUnavailableError } from '../../services/billing-client.js';
import { billingResolvers } from './billing.js';
import type { AuthContext } from './auth.js';

const client = billingClient as unknown as Record<string, ReturnType<typeof vi.fn>>;

function context(): AuthContext {
  return { currentUser: { id: 'u1', username: 'alice' } } as AuthContext;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error('expected rejection');
  } catch (err) {
    expect(err).toBeInstanceOf(GraphQLError);
    expect((err as GraphQLError).extensions?.code).toBe(code);
  }
}

describe('agent-api billing resolvers 错误映射（P2/C2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.getAccount.mockResolvedValue({ id: 'acc-1' });
  });

  it('400 → INVALID_ARGUMENT（createMyBillingApiKey，与 admin-api 统一词汇）', async () => {
    client.createApiKey.mockRejectedValue(new BillingServiceUnavailableError('费用请求参数不合法', 400));
    await expectCode(
      billingResolvers.Mutation.createMyBillingApiKey(null, { name: 'k' }, context()),
      'INVALID_ARGUMENT',
    );
  });

  it('404 → NOT_FOUND（revokeMyBillingApiKey）', async () => {
    client.revokeApiKey.mockRejectedValue(new BillingServiceUnavailableError('费用记录不存在', 404));
    await expectCode(
      billingResolvers.Mutation.revokeMyBillingApiKey(null, { id: 'x' }, context()),
      'NOT_FOUND',
    );
  });

  it('5xx → BILLING_UNAVAILABLE（myBillingApiKeys）', async () => {
    client.listApiKeys.mockRejectedValue(
      new BillingServiceUnavailableError('费用服务暂时不可用，请稍后重试', 503),
    );
    await expectCode(billingResolvers.Query.myBillingApiKeys(null, {}, context()), 'BILLING_UNAVAILABLE');
  });

  it('列表类 resolver 也走映射（myBillingInvoices）', async () => {
    client.listInvoices.mockRejectedValue(new BillingServiceUnavailableError('费用请求参数不合法', 400));
    await expectCode(billingResolvers.Query.myBillingInvoices(null, {}, context()), 'INVALID_ARGUMENT');
  });

  it('B-3: myBillingApiKeys 过滤 scope=cloud_host 运行 Key（费用中心只展示 account Key）', async () => {
    client.listApiKeys.mockResolvedValue([
      {
        id: 'acc-key',
        name: 'account',
        keyPrefix: 'zag_sk_accountaa',
        status: 'active',
        scope: 'account',
        cloudHostId: null,
        expiresAt: null,
        lastUsedAt: null,
        createdAt: '2026-10-20T00:00:00.000Z',
      },
      {
        id: 'host-key',
        name: 'host',
        keyPrefix: 'zag_sk_hostaaaaa',
        status: 'active',
        scope: 'cloud_host',
        cloudHostId: 'host-1',
        expiresAt: '2026-10-21T00:00:00.000Z',
        lastUsedAt: null,
        createdAt: '2026-10-20T00:00:00.000Z',
      },
    ]);

    const keys = await billingResolvers.Query.myBillingApiKeys(null, {}, context());
    expect(keys.map((key) => key.id)).toEqual(['acc-key']);
  });

  it('未认证不受影响（UNAUTHENTICATED）', async () => {
    await expectCode(
      billingResolvers.Query.myBillingApiKeys(null, {}, { currentUser: null } as AuthContext),
      'UNAUTHENTICATED',
    );
  });
});
