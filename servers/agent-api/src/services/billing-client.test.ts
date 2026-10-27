import { describe, it, expect, vi, afterEach } from 'vitest';
import { BillingClient, InsufficientBalanceError } from './billing-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BillingClient 一次性扣费/退款', () => {
  it('T-BC-CH1: createCharge 透传幂等键并在 409 抛余额不足（含 available）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ charged: true, invoice: { id: 'i1' }, receipt: { id: 'r1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'INSUFFICIENT_BALANCE', available: 1 }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new BillingClient('http://admin-api', 'token');
    const input = {
      accountId: 'a1',
      productId: 'cloud_host.create',
      quantity: 1,
      idempotentKey: 'cloud_host.create:h1',
      refType: 'cloud_host',
      refId: 'h1',
      description: '创建云电脑 x',
    };
    await expect(client.createCharge(input)).resolves.toMatchObject({ charged: true });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual(input);
    const rejected = await client.createCharge(input).catch((err) => err);
    expect(rejected).toBeInstanceOf(InsufficientBalanceError);
    expect(rejected).toMatchObject({ available: 1 });
  });

  it('T-BC-RF1: refundCharge 与 getPriceQuote 走内部端点', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ invoice: null, receipt: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ productId: 'cloud_host.create', unitPrice: 5, currency: 'credits' }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new BillingClient('http://admin-api', 'token');
    await expect(
      client.refundCharge({ idempotentKey: 'k', refundKey: 'rk', reason: 'failed' }),
    ).resolves.toEqual({ invoice: null, receipt: null });
    await expect(client.getPriceQuote(['cloud_host.create'])).resolves.toEqual([
      { productId: 'cloud_host.create', unitPrice: 5, currency: 'credits' },
    ]);
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      '/internal/billing/price-quote?productIds=cloud_host.create',
    );
  });
});
