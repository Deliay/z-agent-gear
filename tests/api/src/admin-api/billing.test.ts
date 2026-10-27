import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { adminGql, ensureAdminLogin } from './helpers.js';
import { createFrontUser, type FrontUser } from '../support/front-users.js';

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

const ACCOUNTS_BY_OWNER = `
  query AccountsByOwner($keyword: String, $ownerType: BillingOwnerType) {
    adminBillingAccounts(keyword: $keyword, ownerType: $ownerType) {
      id ownerType ownerId ownerName availableBalance
    }
  }
`;

const ACCOUNT_BY_ID = `
  query Account($id: ID!) {
    adminBillingAccount(id: $id) { id ownerType availableBalance }
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
  // 双 owner 回归共享状态（T-B32 建 tenant 账户 → T-B33 断言互不影响 → T-B34 读兼容）
  let frontUser: FrontUser;
  let frontAccountId = '';

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

  it('T-B32: tenant 计费账户可检索且充值到账（tenant 为新前台 owner）', async () => {
    frontUser = await createFrontUser();
    // 开户已 get-or-create 零余额 tenant 计费账户
    const accounts = await adminGql<{
      adminBillingAccounts: Array<{
        id: string;
        ownerType: string;
        ownerId: string;
        ownerName: string;
        availableBalance: number;
      }>;
    }>(ACCOUNTS_BY_OWNER, { keyword: frontUser.username, ownerType: 'tenant' }, token);
    expect(accounts.errors).toBeUndefined();
    const tenantAccount = accounts.data!.adminBillingAccounts.find(
      (a) => a.ownerId === frontUser.tenantId,
    );
    expect(tenantAccount, 'tenant 计费账户应可由 ownerType=tenant 检索').toBeDefined();
    expect(tenantAccount!.ownerType).toBe('tenant');
    expect(tenantAccount!.ownerName).toBe(frontUser.username);
    expect(tenantAccount!.availableBalance).toBe(0);
    frontAccountId = tenantAccount!.id;

    const recharge = await adminGql<{
      rechargeBillingAccount: { seq: number; amount: number; balanceAfter: number; type: string };
    }>(RECHARGE, { id: frontAccountId, amount: 10, note: 'tenant api test' }, token);
    expect(recharge.errors).toBeUndefined();
    expect(recharge.data!.rechargeBillingAccount).toMatchObject({
      type: 'recharge',
      amount: 10,
      balanceAfter: 10,
    });

    const after = await adminGql<{ adminBillingAccount: { availableBalance: number; ownerType: string } }>(
      ACCOUNT_BY_ID,
      { id: frontAccountId },
      token,
    );
    expect(after.errors).toBeUndefined();
    expect(after.data!.adminBillingAccount.ownerType).toBe('tenant');
    expect(after.data!.adminBillingAccount.availableBalance).toBe(10);

    const invoices = await adminGql<{ adminBillingInvoices: Array<{ type: string; amount: number }> }>(
      INVOICES,
      { id: frontAccountId },
      token,
    );
    expect(invoices.data!.adminBillingInvoices.some((i) => i.type === 'recharge' && i.amount === 10)).toBe(true);
  });

  it('T-B33: admin_user 双 owner 回归（充值/查询互不影响）', async () => {
    expect(frontAccountId).toBeTruthy();
    const adminAccounts = await adminGql<{
      adminBillingAccounts: Array<{ id: string; ownerType: string; availableBalance: number }>;
    }>(ACCOUNTS_BY_OWNER, { ownerType: 'admin_user', keyword: 'admin' }, token);
    expect(adminAccounts.errors).toBeUndefined();
    const adminAccount = adminAccounts.data!.adminBillingAccounts[0];
    expect(adminAccount).toBeDefined();
    expect(adminAccount.ownerType).toBe('admin_user');
    const before = adminAccount.availableBalance;

    const recharge = await adminGql<{
      rechargeBillingAccount: { amount: number; balanceAfter: number };
    }>(RECHARGE, { id: adminAccount.id, amount: 5, note: 'admin_user regression' }, token);
    expect(recharge.errors).toBeUndefined();
    expect(recharge.data!.rechargeBillingAccount.balanceAfter).toBe(before + 5);

    // tenant 账户余额不受 admin_user 充值影响
    const tenantAfter = await adminGql<{ adminBillingAccount: { availableBalance: number } }>(
      ACCOUNT_BY_ID,
      { id: frontAccountId },
      token,
    );
    expect(tenantAfter.data!.adminBillingAccount.availableBalance).toBe(10);
  });

  it.skipIf(!process.env.INTERNAL_API_TOKEN)(
    'T-B34: front_user 读兼容（解析到 tenant 行）+ 写兼容归一为 tenant',
    async () => {
      expect(frontAccountId).toBeTruthy();

      // 读兼容：ownerType=front_user 按同 ownerId 的 tenant 行解析（迁移 014 保证 ownerId 不变）
      const res = await fetch(
        `${ADMIN_HTTP}/internal/billing/account?ownerType=front_user&ownerId=${encodeURIComponent(
          frontUser.tenantId,
        )}&ownerName=${encodeURIComponent(frontUser.username)}`,
        { headers: { Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` } },
      );
      expect(res.status).toBe(200);
      const account = (await res.json()) as { id: string; ownerType: string; ownerId: string };
      expect(account.id).toBe(frontAccountId);
      expect(account.ownerType).toBe('tenant');
      expect(account.ownerId).toBe(frontUser.tenantId);

      // 写兼容：发布窗口内旧 agent-api 仍传 front_user，服务端归一为 tenant（不产生 front_user 新行）
      const write = await fetch(`${ADMIN_HTTP}/internal/billing/api-keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}`,
        },
        body: JSON.stringify({
          ownerType: 'front_user',
          ownerId: frontUser.tenantId,
          name: 'compat-owner',
        }),
      });
      expect(write.status).toBe(201);
      await expect(write.json()).resolves.toMatchObject({
        apiKey: { ownerType: 'tenant', cloudHostId: null },
      });
    },
  );

  it.skipIf(!process.env.INTERNAL_API_TOKEN)(
    'T-B25: internal /receipts 非法 invoiceId 不 500（按无匹配收据处理）',
    async () => {
      const accounts = await adminGql<{ adminBillingAccounts: Array<{ id: string }> }>(
        ACCOUNTS,
        { keyword: null },
        token,
      );
      const accountId = accounts.data!.adminBillingAccounts[0]!.id;

      // 注入一张收据（若可直连 Mongo），确保空串/数组入参不会退化为「返回账户最新收据」
      let seededInvoiceId: string | null = null;
      let db: mongoose.mongo.Db | null = null;
      if (process.env.MONGODB_URI) {
        if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI);
        db = mongoose.connection.db ?? null;
        if (db) {
          seededInvoiceId = new mongoose.Types.ObjectId().toString();
          await db.collection('billingreceipts').insertOne({
            receiptNo: `R-PROBE-${Date.now()}`,
            invoiceId: new mongoose.Types.ObjectId(seededInvoiceId),
            paymentId: null,
            accountId: new mongoose.Types.ObjectId(accountId),
            amount: -1,
            balanceAfter: -1,
            issuedAt: new Date(),
          });
        }
      }

      const res = await fetch(
        `${ADMIN_HTTP}/internal/billing/receipts?accountId=${accountId}&invoiceId=not-an-oid`,
        { headers: { Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` } },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);

      const empty = await fetch(
        `${ADMIN_HTTP}/internal/billing/receipts?accountId=${accountId}&invoiceId=`,
        { headers: { Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` } },
      );
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual([]);

      const arrayParam = await fetch(
        `${ADMIN_HTTP}/internal/billing/receipts?accountId=${accountId}&invoiceId=a&invoiceId=b`,
        { headers: { Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` } },
      );
      expect(arrayParam.status).toBe(200);
      expect(await arrayParam.json()).toEqual([]);

      if (seededInvoiceId) {
        // 对照组：合法 oid 正常命中该收据
        const hit = await fetch(
          `${ADMIN_HTTP}/internal/billing/receipts?accountId=${accountId}&invoiceId=${seededInvoiceId}`,
          { headers: { Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` } },
        );
        expect(hit.status).toBe(200);
        const rows = (await hit.json()) as Array<{ invoiceId: string }>;
        expect(rows.length).toBe(1);
        expect(rows[0]!.invoiceId).toBe(seededInvoiceId);
        await db!.collection('billingreceipts').deleteOne({
          invoiceId: new mongoose.Types.ObjectId(seededInvoiceId),
        });
      }
    },
  );
});
