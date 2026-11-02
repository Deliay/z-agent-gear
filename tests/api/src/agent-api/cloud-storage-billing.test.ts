import { describe, it, expect } from 'vitest';
import { createFrontUser } from '../support/front-users.js';

// admin-api 云存储计费（内部端点 + 账单形态）。
// 需要 Aspire 全量服务与 INTERNAL_API_TOKEN；缺失时整套显式跳过。
const ADMIN_BASE = (process.env.ADMIN_API_URL || 'http://localhost:10003/graphql').replace(
  /\/graphql\/?$/,
  '',
);
const TOKEN = process.env.INTERNAL_API_TOKEN;

function req(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${ADMIN_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

interface AccountWire {
  id: string;
}

async function storageAccount(username: string, userId: string): Promise<AccountWire> {
  const res = await req(
    `/internal/billing/account?ownerType=tenant&ownerId=${encodeURIComponent(
      userId,
    )}&ownerName=${encodeURIComponent(username)}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as AccountWire;
}

interface InvoiceWire {
  id: string;
  category: string;
  amount: number;
  refType: string | null;
  refId: string | null;
  description: string;
  items: Array<{ productId: string; quantity: number; unitPrice: number; amount: number }>;
}

describe.skipIf(!TOKEN)('Cloud Storage billing (admin-api)', () => {
  it('T-BILL-S1: storage-quote exposes full / archived tiers', async () => {
    const res = await req('/internal/billing/storage-quote?sizeGi=20');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sizeGi: number;
      full: { hourlyCredits: number; items: Array<{ productId: string; unitPriceCredits: number; amountCredits: number }> };
      archived: { hourlyCredits: number; items: Array<{ productId: string; unitPriceCredits: number; amountCredits: number }> };
    };
    expect(body.sizeGi).toBe(20);
    expect(body.full.hourlyCredits).toBe(15);
    expect(body.archived.hourlyCredits).toBe(7.5);
    expect(body.full.items.map((item) => item.productId)).toEqual([
      'cloud_storage.base.hour',
      'cloud_storage.tier1.gib_hour',
    ]);
    expect(body.full.items[0]).toMatchObject({ unitPriceCredits: 5, amountCredits: 5 });
    expect(body.full.items[1]).toMatchObject({ unitPriceCredits: 1, amountCredits: 10 });
    expect(body.archived.items[0].unitPriceCredits).toBe(2.5);
  });

  it('T-BILL-S1: invalid quote size is rejected', async () => {
    const res = await req('/internal/billing/storage-quote?sizeGi=99');
    expect(res.status).toBe(400);
  });

  it('T-BILL-S6: FULL and HALF hours produce storage invoices with tier items', async () => {
    const user = await createFrontUser();
    const account = await storageAccount(user.username, user.userId);
    const storageId = '6ae89df88a49c4b953a77d24';
    const key = `test:${Date.now().toString(36)}`;

    const full = await req('/internal/billing/storage-charges', {
      method: 'POST',
      body: JSON.stringify({
        accountId: account.id,
        storageId,
        sizeGi: 20,
        rate: 'FULL',
        periodStart: '2026-11-02T15:00:00.000Z',
        periodEnd: '2026-11-02T16:00:00.000Z',
        idempotentKey: `${key}:full`,
        description: '云存储 api-test（20Gi）15:00-16:00',
      }),
    });
    expect(full.status).toBe(200);
    const fullBody = (await full.json()) as { invoice: InvoiceWire; charged: boolean };
    expect(fullBody.charged).toBe(true);
    expect(fullBody.invoice.category).toBe('storage');
    expect(fullBody.invoice.refType).toBe('cloud_storage');
    expect(fullBody.invoice.refId).toBe(storageId);
    expect(fullBody.invoice.amount).toBe(-1500);
    expect(fullBody.invoice.items).toEqual([
      { productId: 'cloud_storage.base.hour', quantity: 1, unitPrice: 500, amount: 500 },
      { productId: 'cloud_storage.tier1.gib_hour', quantity: 10, unitPrice: 100, amount: 1000 },
    ]);

    const half = await req('/internal/billing/storage-charges', {
      method: 'POST',
      body: JSON.stringify({
        accountId: account.id,
        storageId,
        sizeGi: 20,
        rate: 'HALF',
        periodStart: '2026-11-02T16:00:00.000Z',
        periodEnd: '2026-11-02T17:00:00.000Z',
        idempotentKey: `${key}:half`,
        description: '云存储 api-test（20Gi）16:00-17:00（归档半价）',
      }),
    });
    expect(half.status).toBe(200);
    const halfBody = (await half.json()) as { invoice: InvoiceWire };
    expect(halfBody.invoice.items[0]).toMatchObject({ unitPrice: 250, amount: 250 });
    expect(halfBody.invoice.items[1]).toMatchObject({ unitPrice: 50, amount: 500 });
    expect(halfBody.invoice.amount).toBe(-750);
    expect(halfBody.invoice.description).toContain('（归档半价）');

    // 幂等：同 key 重放返回同一张账单，不重复扣费
    const replay = await req('/internal/billing/storage-charges', {
      method: 'POST',
      body: JSON.stringify({
        accountId: account.id,
        storageId,
        sizeGi: 20,
        rate: 'FULL',
        periodStart: '2026-11-02T15:00:00.000Z',
        periodEnd: '2026-11-02T16:00:00.000Z',
        idempotentKey: `${key}:full`,
      }),
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { invoice: InvoiceWire };
    expect(replayBody.invoice.id).toBe(fullBody.invoice.id);

    // 账单可按 category=storage 查询
    const invoices = await req(
      `/internal/billing/invoices?accountId=${account.id}&category=storage&pageSize=50`,
    );
    expect(invoices.status).toBe(200);
    const list = (await invoices.json()) as InvoiceWire[];
    expect(list.some((invoice) => invoice.id === fullBody.invoice.id)).toBe(true);
    expect(list.every((invoice) => invoice.category === 'storage')).toBe(true);
  });

  it('T-BILL-S6: storage-charges validates period length, rate and size', async () => {
    const user = await createFrontUser();
    const account = await storageAccount(user.username, user.userId);
    const base = {
      accountId: account.id,
      storageId: '6ae89df88a49c4b953a77d24',
      sizeGi: 10,
      rate: 'FULL',
      idempotentKey: `invalid:${Date.now().toString(36)}`,
    };

    const badPeriod = await req('/internal/billing/storage-charges', {
      method: 'POST',
      body: JSON.stringify({
        ...base,
        periodStart: '2026-11-02T15:00:00.000Z',
        periodEnd: '2026-11-02T15:30:00.000Z',
      }),
    });
    expect(badPeriod.status).toBe(400);

    const badRate = await req('/internal/billing/storage-charges', {
      method: 'POST',
      body: JSON.stringify({
        ...base,
        rate: 'FREE',
        periodStart: '2026-11-02T15:00:00.000Z',
        periodEnd: '2026-11-02T16:00:00.000Z',
      }),
    });
    expect(badRate.status).toBe(400);

    const badSize = await req('/internal/billing/storage-charges', {
      method: 'POST',
      body: JSON.stringify({
        ...base,
        sizeGi: 0,
        periodStart: '2026-11-02T15:00:00.000Z',
        periodEnd: '2026-11-02T16:00:00.000Z',
      }),
    });
    expect(badSize.status).toBe(400);
  });
});
