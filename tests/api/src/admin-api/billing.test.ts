import { describe, it, expect, beforeAll, vi } from 'vitest';
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
      id ownerType ownerId ownerName availableBalance cashBalance
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
      id seq type amount balanceAfter refType refId description
      items { productId quantity unitPrice amount meteringRef segment }
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
      inputTokens cachedInputTokens outputTokens
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
      adminBillingAccounts: Array<{ id: string; ownerType: string; availableBalance: number; cashBalance: number }>;
    }>(ACCOUNTS_BY_OWNER, { ownerType: 'admin_user', keyword: 'admin' }, token);
    expect(adminAccounts.errors).toBeUndefined();
    const adminAccount = adminAccounts.data!.adminBillingAccounts[0];
    expect(adminAccount).toBeDefined();
    expect(adminAccount.ownerType).toBe('admin_user');
    // balanceAfter 为现金余额口径（cashBalance），与 availableBalance（含 creditLimit/gift/frozen）不同
    const beforeCash = adminAccount.cashBalance;

    const recharge = await adminGql<{
      rechargeBillingAccount: { amount: number; balanceAfter: number };
    }>(RECHARGE, { id: adminAccount.id, amount: 5, note: 'admin_user regression' }, token);
    expect(recharge.errors).toBeUndefined();
    expect(recharge.data!.rechargeBillingAccount.balanceAfter).toBe(beforeCash + 5);

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

  /**
   * API-AB1 / API-AB2：中断调用 20/80 拆分计价（Issue #355）。
   *
   * 注入方式（实现计划裁决 10）：直写 `billingoutbox`（producer=admin-api、published=false）
   * 驱动真实 outbox → RabbitMQ → 计量 → 出账管线，再经 `adminBillingInvoices` /
   * `adminBillingApiCalls` 断言明细与金额。依赖（MONGODB_URI / RabbitMQ）缺失时显式失败，
   * 不允许静默 skip。
   */
  describe('中断调用计费口径（API-AB1 / API-AB2）', () => {
    async function mongoDb(): Promise<mongoose.mongo.Db> {
      const uri = process.env.MONGODB_URI;
      if (!uri) throw new Error('API-AB1/API-AB2 需要 MONGODB_URI（Aspire 共享 Mongo）');
      if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
      const db = mongoose.connection.db;
      if (!db) throw new Error('MongoDB 连接未就绪');
      return db;
    }

    async function adminAccountId(): Promise<string> {
      const accounts = await adminGql<{
        adminBillingAccounts: Array<{ id: string; ownerType: string; ownerName: string }>;
      }>(ACCOUNTS, { keyword: null }, token);
      expect(accounts.errors).toBeUndefined();
      const account = accounts.data!.adminBillingAccounts[0];
      if (!account) throw new Error('未找到管理员计费账户（请先执行 T-B31 或登录后台生成 Key）');
      return account.id;
    }

    async function seedModelPrice(modelId: string): Promise<void> {
      const db = await mongoDb();
      await db.collection('productprices').updateOne(
        { productId: `model.${modelId}.token` },
        {
          $set: {
            productId: `model.${modelId}.token`,
            productName: modelId,
            pricingModel: 'per_token',
            unitPrice: 0,
            rates: { inputPerMillion: 100, cachedInputPerMillion: 50, outputPerMillion: 200 },
            isBillable: true,
            effectiveFrom: new Date(0),
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );
    }

    async function seedCallAndEvent(input: {
      accountId: string;
      eventType: 'model_call.aborted' | 'model_call.completed';
      requestId: string;
      modelId: string;
      payload: Record<string, unknown>;
    }): Promise<void> {
      const db = await mongoDb();
      await db.collection('billingapicalls').updateOne(
        { requestId: input.requestId },
        {
          $set: {
            requestId: input.requestId,
            accountId: new mongoose.Types.ObjectId(input.accountId),
            apiKeyId: new mongoose.Types.ObjectId(),
            cloudHostId: null,
            billable: true,
            modelId: input.modelId,
            modelName: input.modelId,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            cost: 0,
            status: 'started',
            estimated: false,
            startedAt: new Date(),
            finishedAt: null,
            invoiceSeq: null,
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );
      const eventId = `${input.eventType}:${input.requestId}`;
      const occurredAt = new Date().toISOString();
      await db.collection('billingoutbox').insertOne({
        eventId,
        producer: 'admin-api',
        eventType: input.eventType,
        routingKey: input.eventType,
        payload: {
          eventId,
          eventType: input.eventType,
          occurredAt,
          accountId: input.accountId,
          resourceId: input.requestId,
          payload: { modelId: input.modelId, ...input.payload },
        },
        published: false,
        attempts: 0,
        lastError: null,
        claimedAt: null,
        claimedBy: null,
        failed: false,
        repairOf: null,
        createdAt: new Date(),
        publishedAt: null,
      });
    }

    interface InvoiceWire {
      refId: string | null;
      description: string;
      amount: number;
      items: Array<{ productId: string; quantity: number; unitPrice: number; amount: number; segment: string | null }>;
    }

    async function waitForInvoice(accountId: string, requestId: string): Promise<InvoiceWire> {
      let found: InvoiceWire | undefined;
      await vi.waitFor(
        async () => {
          const invoices = await adminGql<{ adminBillingInvoices: InvoiceWire[] }>(
            INVOICES,
            { id: accountId },
            token,
          );
          expect(invoices.errors).toBeUndefined();
          found = invoices.data!.adminBillingInvoices.find(
            (invoice) => invoice.refId === requestId,
          );
          expect(found).toBeDefined();
        },
        { timeout: 40_000, interval: 1000 },
      );
      return found!;
    }

    it('API-AB1: 中断调用明细两段输入（20%/80%）+ 输出全价，描述注明中断与折算口径', async () => {
      const accountId = await adminAccountId();
      const stamp = Date.now();
      const modelId = `api-ab-${stamp}`;
      const requestId = `api-ab-1-${stamp}`;
      await seedModelPrice(modelId);
      await seedCallAndEvent({
        accountId,
        eventType: 'model_call.aborted',
        requestId,
        modelId,
        payload: {
          inputTokens: 1_000_000,
          cachedInputTokens: 100_000,
          outputTokens: 1_000_000,
          estimated: false,
          reason: 'client_aborted',
        },
      });

      const invoice = await waitForInvoice(accountId, requestId);
      const bySegment = new Map(invoice.items.map((item) => [item.segment, item]));
      expect([...bySegment.keys()]).toEqual(['input:aborted', 'cached_input:aborted', 'output:aborted']);
      expect(bySegment.get('input:aborted')?.quantity).toBe(200_000);
      expect(bySegment.get('cached_input:aborted')?.quantity).toBe(800_000);
      expect(bySegment.get('output:aborted')?.quantity).toBe(1_000_000);
      expect(
        (bySegment.get('input:aborted')?.quantity ?? 0) +
          (bySegment.get('cached_input:aborted')?.quantity ?? 0),
      ).toBe(1_000_000);
      // 折后金额 2.6 credits < 全价口径 2.95 credits（wire 金额统一为 credits，见 mappers）
      expect(invoice.amount).toBe(-2.6);
      // 明细金额同口径（credits，明细为正数、账单消费为负数），且各段之和等于整单金额绝对值
      expect(invoice.items.reduce((acc, item) => acc + item.amount, 0)).toBeCloseTo(2.6, 10);
      expect(invoice.description).toContain('中断');
      expect(invoice.description).toContain('20% 未缓存 + 80% 缓存');

      // 回写调用记录：三段实际用量 + 折后 cost
      await vi.waitFor(
        async () => {
          const calls = await adminGql<{
            adminBillingApiCalls: Array<{
              requestId: string;
              status: string;
              cost: number;
              inputTokens: number;
              cachedInputTokens: number;
              outputTokens: number;
            }>;
          }>(API_CALLS, { id: accountId }, token);
          expect(calls.errors).toBeUndefined();
          const call = calls.data!.adminBillingApiCalls.find((row) => row.requestId === requestId);
          expect(call).toBeDefined();
          expect(call!.status).toBe('aborted');
          expect(call!.cost).toBe(2.6);
          expect(call!.inputTokens).toBe(1_000_000);
          expect(call!.cachedInputTokens).toBe(100_000);
          expect(call!.outputTokens).toBe(1_000_000);
        },
        { timeout: 20_000, interval: 500 },
      );
    }, 60_000);

    it('API-AB2: 正常调用金额回归（三段实际用量计价，零改动）', async () => {
      const accountId = await adminAccountId();
      const stamp = Date.now();
      const modelId = `api-ab-done-${stamp}`;
      const requestId = `api-ab-2-${stamp}`;
      await seedModelPrice(modelId);
      await seedCallAndEvent({
        accountId,
        eventType: 'model_call.completed',
        requestId,
        modelId,
        payload: {
          inputTokens: 1_000_000,
          cachedInputTokens: 100_000,
          outputTokens: 1_000_000,
        },
      });

      const invoice = await waitForInvoice(accountId, requestId);
      expect(invoice.items.map((item) => item.segment)).toEqual([
        'input',
        'cached_input',
        'output',
      ]);
      expect(invoice.items.map((item) => item.quantity)).toEqual([900_000, 100_000, 1_000_000]);
      // wire 金额统一为 credits（mapper centsToCredits）：295 分 → 2.95 credits
      expect(invoice.amount).toBe(-2.95);
      expect(invoice.items.reduce((acc, item) => acc + item.amount, 0)).toBeCloseTo(2.95, 10);
      expect(invoice.description).not.toContain('20% 未缓存 + 80% 缓存');

      await vi.waitFor(
        async () => {
          const calls = await adminGql<{
            adminBillingApiCalls: Array<{
              requestId: string;
              status: string;
              cost: number;
              inputTokens: number;
              cachedInputTokens: number;
              outputTokens: number;
            }>;
          }>(API_CALLS, { id: accountId }, token);
          const call = calls.data!.adminBillingApiCalls.find((row) => row.requestId === requestId);
          expect(call).toBeDefined();
          expect(call!.status).toBe('completed');
          expect(call!.cost).toBe(2.95);
          expect(call!.inputTokens).toBe(1_000_000);
          expect(call!.cachedInputTokens).toBe(100_000);
        },
        { timeout: 20_000, interval: 500 },
      );
    }, 60_000);
  });
});
