import { describe, it, expect, beforeAll } from 'vitest';
import { adminGql, ensureAdminLogin } from './helpers.js';

const ADMIN_HTTP = (process.env.ADMIN_API_URL || 'http://localhost:10003/graphql').replace(
  /\/graphql$/,
  '',
);

const CREATE_KEY = `
  mutation CreateBillingApiKey($name: String!) {
    createBillingApiKey(name: $name) {
      apiKey { id name keyPrefix status }
      secret
    }
  }
`;

const REVOKE_KEY = `
  mutation RevokeBillingApiKey($id: ID!) {
    revokeBillingApiKey(id: $id) { id status }
  }
`;

const ACCOUNTS = `
  query Accounts($keyword: String) {
    adminBillingAccounts(keyword: $keyword) {
      id ownerType ownerName cashBalance creditLimit frozenAmount availableBalance status
    }
  }
`;

const RECHARGE = `
  mutation Recharge($id: ID!, $amount: Float!, $note: String) {
    rechargeBillingAccount(accountId: $id, amount: $amount, note: $note) {
      id seq type amount balanceAfter description
    }
  }
`;

const INVOICES = `
  query Invoices($id: ID!) {
    adminBillingInvoices(accountId: $id, page: 1, pageSize: 20) {
      id seq type amount balanceAfter items { productId quantity unitPrice amount meteringRef segment }
    }
  }
`;

const RECEIPTS = `
  query Receipts($id: ID!) {
    adminBillingReceipts(accountId: $id, page: 1, pageSize: 20) { id receiptNo amount balanceAfter }
  }
`;

const ROLLUPS = `
  query Rollups($id: ID!, $granularity: BillingRollupGranularity!, $from: String!, $to: String!) {
    adminBillingRollups(accountId: $id, granularity: $granularity, from: $from, to: $to) {
      bucketStart chargeTotal rechargeTotal chargeCount
    }
  }
`;

const SET_CREDIT_LIMIT = `
  mutation SetCreditLimit($id: ID!, $creditLimit: Float!) {
    setBillingAccountCreditLimit(accountId: $id, creditLimit: $creditLimit) {
      id creditLimit availableBalance
    }
  }
`;

const API_CALLS = `
  query ApiCalls($id: ID!) {
    adminBillingApiCalls(accountId: $id, page: 1, pageSize: 5) {
      id requestId modelId status estimated cost invoiceSeq startedAt
    }
  }
`;

const RECONCILE = `
  mutation Reconcile($id: ID!) {
    reconcileBillingAccount(accountId: $id) { id cashBalance frozenAmount availableBalance }
  }
`;

describe('Admin Billing API', () => {
  let token = '';

  beforeAll(async () => {
    token = await ensureAdminLogin();
  });

  it('T-B31: 账户/充值/账单/收据/汇总/授信/Key 契约一致', async () => {
    // 建 Key 会为当前管理员 get-or-create 账户，作为后续充值目标
    const created = await adminGql<{
      createBillingApiKey: { apiKey: { id: string }; secret: string };
    }>(CREATE_KEY, { name: `api-test-${Date.now()}` }, token);
    expect(created.errors).toBeUndefined();
    const keyId = created.data!.createBillingApiKey.apiKey.id;
    expect(created.data!.createBillingApiKey.secret).toMatch(/^zag_sk_[0-9a-f]+$/);

    const accounts = await adminGql<{
      adminBillingAccounts: Array<{ id: string; ownerName: string }>;
    }>(ACCOUNTS, { keyword: 'admin' }, token);
    expect(accounts.errors).toBeUndefined();
    expect(accounts.data!.adminBillingAccounts.length).toBeGreaterThan(0);
    const accountId = accounts.data!.adminBillingAccounts[0].id;

    const recharge = await adminGql<{
      rechargeBillingAccount: { seq: number; amount: number; balanceAfter: number; type: string };
    }>(RECHARGE, { id: accountId, amount: 10, note: 'api test' }, token);
    expect(recharge.errors).toBeUndefined();
    expect(recharge.data!.rechargeBillingAccount.type).toBe('recharge');
    expect(recharge.data!.rechargeBillingAccount.amount).toBe(10);

    const invoices = await adminGql<{ adminBillingInvoices: Array<{ type: string; amount: number }> }>(
      INVOICES,
      { id: accountId },
      token,
    );
    expect(invoices.errors).toBeUndefined();
    expect(invoices.data!.adminBillingInvoices.length).toBeGreaterThan(0);
    expect(invoices.data!.adminBillingInvoices.some((invoice) => invoice.type === 'recharge')).toBe(true);

    const receipts = await adminGql<{ adminBillingReceipts: Array<{ receiptNo: string }> }>(
      RECEIPTS,
      { id: accountId },
      token,
    );
    expect(receipts.errors).toBeUndefined();
    expect(receipts.data!.adminBillingReceipts.length).toBeGreaterThan(0);
    expect(receipts.data!.adminBillingReceipts[0].receiptNo).toMatch(/^R\d+/);

    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date().toISOString();
    const rollups = await adminGql(ROLLUPS, { id: accountId, granularity: 'day', from, to }, token);
    expect(rollups.errors).toBeUndefined();

    const limit = await adminGql<{ setBillingAccountCreditLimit: { creditLimit: number } }>(
      SET_CREDIT_LIMIT,
      { id: accountId, creditLimit: 20 },
      token,
    );
    expect(limit.errors).toBeUndefined();
    expect(limit.data!.setBillingAccountCreditLimit.creditLimit).toBe(20);

    const reconciled = await adminGql(RECONCILE, { id: accountId }, token);
    expect(reconciled.errors).toBeUndefined();

    const calls = await adminGql(API_CALLS, { id: accountId }, token);
    expect(calls.errors).toBeUndefined();

    const revoked = await adminGql<{ revokeBillingApiKey: { status: string } }>(
      REVOKE_KEY,
      { id: keyId },
      token,
    );
    expect(revoked.errors).toBeUndefined();
    expect(revoked.data!.revokeBillingApiKey.status).toBe('revoked');
  });

  it('T-B30: /internal/billing/* 无 token 401', async () => {
    const res = await fetch(`${ADMIN_HTTP}/internal/billing/account?ownerType=admin_user&ownerId=x`);
    expect(res.status).toBe(401);
  });

  it('T-B23: /v1 无效 API Key 401', async () => {
    const res = await fetch(`${ADMIN_HTTP}/v1/models`, {
      headers: { Authorization: 'Bearer zag_sk_deadbeef' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_api_key');
  });
});
