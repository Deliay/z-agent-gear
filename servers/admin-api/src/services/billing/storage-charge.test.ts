import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BillingAccount } from '../../models/billing-account.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { BillingLedger } from '../../models/billing-ledger.js';
import { BillingPayment } from '../../models/billing-payment.js';
import { MeteringRecord } from '../../models/metering-record.js';
import { pricingService } from './pricing.js';
import {
  InsufficientBalanceError,
  InvalidChargeInputError,
} from './one-time-charge.js';
import { STORAGE_BILLING_PERIOD_MS, storageChargeService } from './storage-charge.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

const STORAGE_ID = '64b7f9a2c1d3e4f5a6b7c8d9';
const START = new Date('2026-11-02T15:00:00.000Z');
const END = new Date(START.getTime() + STORAGE_BILLING_PERIOD_MS);

describe('StorageChargeService（T-BILL-S6 账单形态 / T-BILL-S3 幂等）', () => {
  beforeAll(async () => {
    await connectTestDb();
    await pricingService.ensureDefaultPrices();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
    await pricingService.ensureDefaultPrices();
  });

  async function account(cashBalance = 100_000) {
    const doc = await BillingAccount.create({
      ownerType: 'tenant',
      ownerId: 'tenant-1',
      ownerName: 'tenant',
      cashBalance,
    });
    return String(doc._id);
  }

  const input = (accountId: string, overrides: Record<string, unknown> = {}) => ({
    accountId,
    storageId: STORAGE_ID,
    sizeGi: 30,
    rate: 'FULL' as const,
    periodStart: START,
    periodEnd: END,
    idempotentKey: `cloud_storage.hour:${STORAGE_ID}:495000`,
    ...overrides,
  });

  it('T-BILL-S6: FULL 小时 → category=storage、三档明细、refType=cloud_storage', async () => {
    const accountId = await account();
    const result = await storageChargeService.chargeHour(input(accountId));
    const invoice = result.invoice as {
      category: string;
      type: string;
      amount: number;
      refType: string;
      refId: string;
      description: string;
      items: Array<{
        productId: string;
        quantity: number;
        unitPrice: number;
        amount: number;
        meteringRef: string | null;
      }>;
    };
    expect(invoice.category).toBe('storage');
    expect(invoice.type).toBe('charge');
    expect(invoice.refType).toBe('cloud_storage');
    expect(invoice.refId).toBe(STORAGE_ID);
    expect(invoice.amount).toBe(-3500);
    expect(
      invoice.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
        meteringRef: item.meteringRef ?? null,
      })),
    ).toEqual([
      {
        productId: 'cloud_storage.base.hour',
        quantity: 1,
        unitPrice: 500,
        amount: 500,
        meteringRef: expect.any(String),
      },
      {
        productId: 'cloud_storage.tier1.gib_hour',
        quantity: 15,
        unitPrice: 100,
        amount: 1500,
        meteringRef: null,
      },
      {
        productId: 'cloud_storage.tier2.gib_hour',
        quantity: 5,
        unitPrice: 300,
        amount: 1500,
        meteringRef: null,
      },
    ]);
    expect(invoice.description).toContain('30Gi');

    const metering = await MeteringRecord.findOne({ resourceId: STORAGE_ID }).lean();
    expect(metering?.productId).toBe('cloud_storage.base.hour');
    expect(metering?.quantity).toBe(1);
    expect(metering?.resourceType).toBe('cloud_storage');
    expect(metering?.eventId).toBe(
      `metering:cloud_storage.hour:${STORAGE_ID}:495000`,
    );
  });

  it('T-BILL-S6: HALF 小时 → 单价/金额减半且描述含「（归档半价）」', async () => {
    const accountId = await account();
    const result = await storageChargeService.chargeHour(
      input(accountId, {
        sizeGi: 20,
        rate: 'HALF',
        idempotentKey: `cloud_storage.hour:${STORAGE_ID}:496000`,
      }),
    );
    const invoice = result.invoice as {
      amount: number;
      description: string;
      items: Array<{ productId: string; unitPrice: number; amount: number }>;
    };
    expect(invoice.amount).toBe(-750);
    expect(invoice.description).toContain('（归档半价）');
    expect(
      invoice.items.map((item) => ({
        productId: item.productId,
        quantity: (item as unknown as { quantity: number }).quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
      })),
    ).toEqual([
      { productId: 'cloud_storage.base.hour', quantity: 1, unitPrice: 250, amount: 250 },
      { productId: 'cloud_storage.tier1.gib_hour', quantity: 10, unitPrice: 50, amount: 500 },
    ]);
  });

  it('T-BILL-S3: 同幂等键重放返回首单，不重复出账/扣费/计量', async () => {
    const accountId = await account();
    const first = await storageChargeService.chargeHour(input(accountId));
    const second = await storageChargeService.chargeHour(input(accountId));
    expect(String((second.invoice as { _id: unknown })._id)).toBe(
      String((first.invoice as { _id: unknown })._id),
    );
    expect(await BillingInvoice.countDocuments({ accountId })).toBe(1);
    expect(await BillingPayment.countDocuments({ accountId })).toBe(1);
    expect(await BillingLedger.countDocuments({ accountId })).toBe(1);
    expect(await MeteringRecord.countDocuments({ resourceId: STORAGE_ID })).toBe(1);
    expect((await BillingAccount.findById(accountId))?.cashBalance).toBe(100_000 - 3500);
  });

  it('T-BILL-S4: 余额不足拒绝且不产生账务/计量记录', async () => {
    const accountId = await account(100);
    await expect(storageChargeService.chargeHour(input(accountId))).rejects.toBeInstanceOf(
      InsufficientBalanceError,
    );
    expect(await BillingInvoice.countDocuments()).toBe(0);
    expect(await BillingPayment.countDocuments()).toBe(0);
    expect(await BillingLedger.countDocuments()).toBe(0);
    expect(await MeteringRecord.countDocuments()).toBe(0);
  });

  it('账期必须恰为 1 小时；rate/sizeGi 非法拒绝', async () => {
    const accountId = await account();
    await expect(
      storageChargeService.chargeHour(
        input(accountId, { periodEnd: new Date(END.getTime() + 1) }),
      ),
    ).rejects.toBeInstanceOf(InvalidChargeInputError);
    await expect(
      storageChargeService.chargeHour(input(accountId, { rate: 'THIRD' })),
    ).rejects.toBeInstanceOf(InvalidChargeInputError);
    await expect(
      storageChargeService.chargeHour(input(accountId, { sizeGi: 31 })),
    ).rejects.toBeInstanceOf(InvalidChargeInputError);
    expect(await BillingInvoice.countDocuments()).toBe(0);
  });

  it('账户不存在 → AccountNotFoundError', async () => {
    const result = storageChargeService.chargeHour(
      input('64b7f9a2c1d3e4f5a6b7c8d0'),
    );
    await expect(result).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });
});
