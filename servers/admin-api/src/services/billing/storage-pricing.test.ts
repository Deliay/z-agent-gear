import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { logger as rootLogger } from '../../observability/logger.js';
import { createTestLogger } from '../../observability/testing.js';
import { ProductPrice } from '../../models/product-price.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

/** 在模块加载前拦截 `logger.child(...)`，断言缺档回退告警。 */
const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const { quoteStorageHourly, storagePricingService, DEFAULT_STORAGE_UNIT_PRICES } = await import(
  './storage-pricing.js'
);
const { pricingService } = await import('./pricing.js');
childSpy.mockRestore();

const SIZES = [1, 10, 11, 15, 20, 25, 26, 30];
const FULL_CREDITS: Record<number, number> = {
  1: 5,
  10: 5,
  11: 6,
  15: 10,
  20: 15,
  25: 20,
  26: 23,
  30: 35,
};

describe('storage-pricing（T-BILL-S1 报价边界）', () => {
  it('纯函数：全价/归档半价与分档数量', () => {
    for (const sizeGi of SIZES) {
      const quote = quoteStorageHourly(sizeGi);
      expect(quote.sizeGi).toBe(sizeGi);
      expect(quote.full.hourlyCredits, `${sizeGi}Gi full`).toBe(FULL_CREDITS[sizeGi]);
      expect(quote.archived.hourlyCredits, `${sizeGi}Gi archived`).toBe(
        (FULL_CREDITS[sizeGi] as number) / 2,
      );
      expect(quote.archived.items.map((item) => item.unitPrice)).toEqual(
        quote.full.items.map((item) => item.unitPrice / 2),
      );
      expect(quote.full.items.reduce((acc, item) => acc + item.amount, 0)).toBe(
        quote.full.hourlyCents,
      );
      expect(quote.archived.items.reduce((acc, item) => acc + item.amount, 0)).toBe(
        quote.archived.hourlyCents,
      );
      // 半价恒为整数分（默认价目均为 100 的整数倍）
      for (const item of quote.archived.items) {
        expect(Number.isInteger(item.unitPrice)).toBe(true);
        expect(Number.isInteger(item.amount)).toBe(true);
      }
    }
  });

  it('纯函数：分档明细只输出数量 > 0 的档位', () => {
    expect(quoteStorageHourly(10).full.items.map((item) => item.productId)).toEqual([
      'cloud_storage.base.hour',
    ]);
    expect(quoteStorageHourly(20).full.items).toEqual([
      { productId: 'cloud_storage.base.hour', quantity: 1, unitPrice: 500, amount: 500 },
      { productId: 'cloud_storage.tier1.gib_hour', quantity: 10, unitPrice: 100, amount: 1000 },
    ]);
    expect(quoteStorageHourly(30).full.items[2]).toEqual({
      productId: 'cloud_storage.tier2.gib_hour',
      quantity: 5,
      unitPrice: 300,
      amount: 1500,
    });
  });

  it('纯函数：管理员调价出现奇数分时半价仍为整数分且明细合计一致', () => {
    const quote = quoteStorageHourly(20, {
      baseCents: 501,
      tier1Cents: 101,
      tier2Cents: 301,
    });
    expect(quote.full.hourlyCents).toBe(1511);
    expect(quote.archived.hourlyCents).toBe(
      quote.archived.items.reduce((acc, item) => acc + item.amount, 0),
    );
    for (const item of quote.archived.items) {
      expect(Number.isInteger(item.unitPrice)).toBe(true);
      expect(Number.isInteger(item.amount)).toBe(true);
      expect(item.amount).toBe(item.quantity * item.unitPrice);
    }
    expect(quote.archived.items).toEqual([
      { productId: 'cloud_storage.base.hour', quantity: 1, unitPrice: 250, amount: 250 },
      { productId: 'cloud_storage.tier1.gib_hour', quantity: 10, unitPrice: 50, amount: 500 },
    ]);
  });

  it('容量非法（0/31/小数）拒绝报价', () => {
    for (const sizeGi of [0, 31, 10.5, Number.NaN]) {
      expect(() => quoteStorageHourly(sizeGi)).toThrow(
        'storage size must be between 1 and 30 Gi',
      );
    }
  });

  it('默认价目常量与提案 §4.3 一致', () => {
    expect(DEFAULT_STORAGE_UNIT_PRICES).toEqual({
      baseCents: 500,
      tier1Cents: 100,
      tier2Cents: 300,
    });
  });
});

describe('StoragePricingService（T-BILL-S1 缺档回退）', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
    testLog.reset();
  });

  it('缺价目（productprices 空）回退默认价并 warn', async () => {
    const quote = await storagePricingService.quote(30);
    expect(quote.full.hourlyCredits).toBe(35);
    expect(quote.archived.hourlyCredits).toBe(17.5);
    const warns = testLog.records.filter((record) => record.level === 'warn');
    expect(warns.map((record) => record.productId).sort()).toEqual([
      'cloud_storage.base.hour',
      'cloud_storage.tier1.gib_hour',
      'cloud_storage.tier2.gib_hour',
    ]);
  });

  it('读取 productprices 既有价目（不覆盖管理员调价）', async () => {
    await ProductPrice.create({
      productId: 'cloud_storage.base.hour',
      pricingModel: 'per_unit',
      unitPrice: 600,
      effectiveFrom: new Date(0),
    });
    await ProductPrice.create({
      productId: 'cloud_storage.tier1.gib_hour',
      pricingModel: 'per_unit',
      unitPrice: 200,
      effectiveFrom: new Date(0),
    });
    const quote = await storagePricingService.quote(20);
    // base 600 + tier1(10 × 200) + tier2 缺档回退 300×0
    expect(quote.full.hourlyCents).toBe(2600);
    expect(quote.archived.hourlyCents).toBe(1300);
  });

  it('ensureDefaultPrices 写入三档默认价且 $setOnInsert 不覆盖既有调价', async () => {
    await pricingService.ensureDefaultPrices();
    const prices = await ProductPrice.find({
      productId: { $in: [
        'cloud_storage.base.hour',
        'cloud_storage.tier1.gib_hour',
        'cloud_storage.tier2.gib_hour',
      ] },
    }).lean();
    const byId = new Map(prices.map((doc) => [doc.productId, doc.unitPrice]));
    expect(byId.get('cloud_storage.base.hour')).toBe(500);
    expect(byId.get('cloud_storage.tier1.gib_hour')).toBe(100);
    expect(byId.get('cloud_storage.tier2.gib_hour')).toBe(300);

    await ProductPrice.updateOne(
      { productId: 'cloud_storage.base.hour' },
      { $set: { unitPrice: 900 } },
    );
    await pricingService.ensureDefaultPrices();
    const base = await ProductPrice.findOne({ productId: 'cloud_storage.base.hour' }).lean();
    expect(base?.unitPrice).toBe(900);
  });
});
