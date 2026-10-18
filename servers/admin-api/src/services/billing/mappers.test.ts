import { describe, it, expect } from 'vitest';
import {
  toBillingAccountWire,
  toBillingInvoice,
  toBillingReceipt,
  toBillingReservation,
  toBillingRollup,
} from './mappers.js';

describe('mappers（契约边界：分 → credits）', () => {
  it('回归 R2: 账户金额除以 100（与账单侧口径一致）', () => {
    const wire = toBillingAccountWire({
      id: 'a1',
      ownerType: 'front_user',
      ownerId: 'u1',
      ownerName: 'alice',
      cashBalance: 2000,
      giftBalance: 0,
      creditLimit: 1000,
      frozenAmount: 500,
      availableBalance: 2500,
      status: 'active',
      insufficientSince: null,
      invoiceSeq: 3,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-01T00:00:00Z'),
    });
    expect(wire.cashBalance).toBe(20);
    expect(wire.creditLimit).toBe(10);
    expect(wire.frozenAmount).toBe(5);
    expect(wire.availableBalance).toBe(25);
    expect(wire.invoiceSeq).toBe(3);
  });

  it('账单/明细/汇总金额除以 100，时间 ISO', () => {
    const invoice = toBillingInvoice({
      _id: 'i1',
      accountId: 'a1',
      seq: 0,
      type: 'charge',
      category: 'container',
      amount: -300,
      balanceAfter: 700,
      refType: 'container',
      refId: 'c1',
      description: 'x',
      items: [{ productId: 'container.minute', quantity: 3, unitPrice: 100, amount: 300, meteringRef: null }],
      receiptId: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
    } as never);
    expect(invoice.amount).toBe(-3);
    expect(invoice.balanceAfter).toBe(7);
    expect(invoice.items[0].unitPrice).toBe(1);
    expect(invoice.createdAt).toBe('2026-10-01T00:00:00.000Z');

    const rollup = toBillingRollup({
      bucketStart: new Date('2026-10-01T00:00:00Z'),
      chargeTotal: 500,
      rechargeTotal: 1000,
      chargeCount: 2,
    });
    expect(rollup.chargeTotal).toBe(5);
    expect(rollup.rechargeTotal).toBe(10);

    const receipt = toBillingReceipt({
      _id: 'rc1',
      receiptNo: 'R1',
      invoiceId: 'i1',
      accountId: 'a1',
      amount: 300,
      balanceAfter: 700,
      issuedAt: new Date('2026-10-01T00:00:00Z'),
    } as never);
    expect(receipt.amount).toBe(3);
    expect(receipt.issuedAt).toBe('2026-10-01T00:00:00.000Z');

    const reservation = toBillingReservation({
      _id: 'r1',
      accountId: 'a1',
      resourceId: 'c1',
      status: 'ACTIVE',
      reservedTotal: 600,
      settledTotal: 100,
      releasedTotal: 100,
      startedAt: new Date('2026-10-01T00:00:00Z'),
      lastSettleAt: new Date('2026-10-01T00:01:00Z'),
    } as never);
    expect(reservation.reservedTotal).toBe(6);
    expect(reservation.status).toBe('ACTIVE');
  });
});
