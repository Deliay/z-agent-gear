import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';

// admin-api 内部一次性扣费/退款/报价（需要 Aspire + INTERNAL_API_TOKEN + MONGODB_URI）。
const ADMIN_BASE = (process.env.ADMIN_API_URL || 'http://localhost:10003/graphql').replace(
  /\/graphql\/?$/,
  '',
);
const TOKEN = process.env.INTERNAL_API_TOKEN;
const HAS_MONGO = Boolean(process.env.MONGODB_URI);
const ENABLED = Boolean(TOKEN && HAS_MONGO);

function internal(path: string, init: RequestInit = {}) {
  return fetch(`${ADMIN_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function seedAccount(cashBalance: number): Promise<string> {
  if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI!);
  const _id = new mongoose.Types.ObjectId();
  const now = new Date();
  await mongoose.connection.db!.collection('billingaccounts').insertOne({
    _id,
    ownerType: 'tenant',
    ownerId: new mongoose.Types.ObjectId().toString(),
    ownerName: 'api-test',
    cashBalance,
    giftBalance: 0,
    creditLimit: 0,
    frozenAmount: 0,
    status: 'active',
    invoiceSeq: 0,
    insufficientSince: null,
    createdAt: now,
    updatedAt: now,
  });
  return _id.toString();
}

describe.skipIf(!ENABLED)('Internal Billing one-time charge API', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI!);
  });

  it('T-B-CH1: 无 token 401；成功扣费 5 credits 并生成账单/收据', async () => {
    expect(
      (
        await internal('/internal/billing/charges', {
          method: 'POST',
          headers: { Authorization: '' },
        })
      ).status,
    ).toBe(401);
    const accountId = await seedAccount(1000);
    const res = await internal('/internal/billing/charges', {
      method: 'POST',
      body: JSON.stringify({
        accountId,
        productId: 'cloud_host.create',
        quantity: 1,
        idempotentKey: `cloud_host.create:${accountId}`,
        refType: 'cloud_host',
        refId: accountId,
        description: '创建云电脑 api-test',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      charged: boolean;
      invoice: { amount: number; refType: string; refId: string };
      receipt: { id: string };
    };
    expect(body.charged).toBe(true);
    expect(body.invoice).toMatchObject({ amount: -500, refType: 'cloud_host' });
    expect(body.receipt.id).toBeTruthy();
  });

  it('T-B-CH2: 余额不足 409 INSUFFICIENT_BALANCE 带 available', async () => {
    const accountId = await seedAccount(100);
    const res = await internal('/internal/billing/charges', {
      method: 'POST',
      body: JSON.stringify({
        accountId,
        productId: 'cloud_host.create',
        quantity: 1,
        idempotentKey: `cloud_host.create:poor:${accountId}`,
        refType: 'cloud_host',
        refId: accountId,
        description: '创建云电脑 poor',
      }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'INSUFFICIENT_BALANCE', available: 1 });
  });

  it('T-B-CH3/T-B-CH4: 退款幂等且报价返回 5/1', async () => {
    const accountId = await seedAccount(1000);
    const key = `cloud_host.create:refund:${accountId}`;
    const refundKey = `cloud_host.create.refund:${accountId}`;
    await internal('/internal/billing/charges', {
      method: 'POST',
      body: JSON.stringify({
        accountId,
        productId: 'cloud_host.create',
        quantity: 1,
        idempotentKey: key,
        refType: 'cloud_host',
        refId: accountId,
        description: '创建云电脑 refund',
      }),
    });
    const refund = () =>
      internal('/internal/billing/refunds', {
        method: 'POST',
        body: JSON.stringify({ idempotentKey: key, refundKey, reason: 'start failed' }),
      });
    expect((await refund()).status).toBe(200);
    expect((await refund()).status).toBe(200);

    const quote = await internal(
      '/internal/billing/price-quote?productIds=cloud_host.create,container.minute',
    );
    expect(await quote.json()).toEqual([
      { productId: 'cloud_host.create', unitPrice: 5, currency: 'credits' },
      { productId: 'container.minute', unitPrice: 1, currency: 'credits' },
    ]);
  });
});

