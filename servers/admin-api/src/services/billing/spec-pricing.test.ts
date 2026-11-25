import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ProductPrice } from '../../models/product-price.js';
import { pricingService } from './pricing.js';
import {
  assertSpecResources,
  DEFAULT_SPEC_UNIT_PRICES,
  quoteSpecHourly,
  SpecPricingService,
  specPricingService,
} from './spec-pricing.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from './testing/mongo.js';

const RESOURCES_8C16G20G = { cpu: 8, memoryGi: 16, ephemeralStorageGi: 20 };

describe('spec-pricing（T-SPQ 计价边界）', () => {
  it('T-SPQ1: 8C 16G 20G 默认价目 = 820 credits/小时', () => {
    const quote = quoteSpecHourly(RESOURCES_8C16G20G);
    expect(quote.hourlyCents).toBe(82_000);
    expect(quote.hourlyCredits).toBe(820);
    expect(quote.tiers).toHaveLength(6);
    // CPU 4×15 + 4×30 = 180；内存 4×15+4×30+8×45 = 540；临时存储 10×10 = 100
    expect(quote.tiers.map((tier) => tier.amountCredits)).toEqual([60, 120, 60, 120, 360, 100]);
    expect(quote.tiers.reduce((acc, tier) => acc + tier.amountCredits, 0)).toBe(820);
  });

  it('T-SPQ2: 七档边界（4C / 4~8~16G / 10G 免费额度）', () => {
    const at4 = quoteSpecHourly({ cpu: 4, memoryGi: 4, ephemeralStorageGi: 10 });
    expect(at4.tiers.map((tier) => [tier.amountCredits])).toEqual([[60], [60]]);
    const justOver = quoteSpecHourly({ cpu: 5, memoryGi: 5, ephemeralStorageGi: 11 });
    expect(justOver.tiers.map((tier) => tier.amountCredits)).toEqual([
      60, 30, 60, 30, 10,
    ]);
    const at16 = quoteSpecHourly({ cpu: 1, memoryGi: 16, ephemeralStorageGi: 1 });
    expect(at16.tiers.map((tier) => tier.amountCredits)).toEqual([15, 60, 120, 360]);
    const over16 = quoteSpecHourly({ cpu: 1, memoryGi: 17, ephemeralStorageGi: 1 });
    expect(over16.hourlyCredits).toBe(15 + 60 + 120 + 360 + 60);
  });

  it('T-SPQ3: 全零（不限制）= 0，无分档明细', () => {
    const quote = quoteSpecHourly({ cpu: 0, memoryGi: 0, ephemeralStorageGi: 0 });
    expect(quote.hourlyCents).toBe(0);
    expect(quote.hourlyCredits).toBe(0);
    expect(quote.items).toEqual([]);
    expect(quote.tiers).toEqual([]);
  });

  it('T-SPQ4: 规格组合校验（部分为 0/超上限/非整数拒绝）', () => {
    for (const invalid of [
      { cpu: 0, memoryGi: 4, ephemeralStorageGi: 10 },
      { cpu: 4, memoryGi: 0, ephemeralStorageGi: 10 },
      { cpu: 4, memoryGi: 4, ephemeralStorageGi: 0 },
      { cpu: 65, memoryGi: 4, ephemeralStorageGi: 10 },
      { cpu: 4, memoryGi: 257, ephemeralStorageGi: 10 },
      { cpu: 4, memoryGi: 4, ephemeralStorageGi: 513 },
      { cpu: 1.5, memoryGi: 4, ephemeralStorageGi: 10 },
    ]) {
      expect(() => assertSpecResources(invalid)).toThrow('invalid spec resources');
    }
    expect(assertSpecResources({ cpu: 0, memoryGi: 0, ephemeralStorageGi: 0 })).toEqual({
      cpu: 0,
      memoryGi: 0,
      ephemeralStorageGi: 0,
    });
  });

  describe('SpecPricingService（T-SPQ5~8：真库价目）', () => {
    beforeAll(async () => {
      await connectTestDb();
    }, 60000);
    afterAll(async () => {
      await disconnectTestDb();
    });
    beforeEach(async () => {
      await clearTestDb();
      await pricingService.ensureDefaultPrices();
    });

    it('T-SPQ5: 缺档回落默认价并 warn（不漏计）', async () => {
      const service = new SpecPricingService({
        getPrice: async () => null,
      } as never);
      const quote = await service.quote(RESOURCES_8C16G20G);
      expect(quote.hourlyCredits).toBe(820);
    });

    it('T-SPQ6: 读取 productprices 生效价目（调价生效）', async () => {
      await ProductPrice.updateOne(
        { productId: 'cloud_spec.cpu.tier1' },
        { $set: { unitPrice: 2000 } },
      );
      const quote = await specPricingService.quote(RESOURCES_8C16G20G);
      // CPU tier1 4 核单价 15→20 credits：+20 credits，其余不变
      expect(quote.hourlyCredits).toBe(840);
    });

    it('T-SPQ7: 按指定时刻取价（effectiveFrom 边界）', async () => {
      const at = new Date('2026-01-01T00:00:00.000Z');
      await ProductPrice.create({
        productId: 'cloud_spec.cpu.tier1',
        productName: 'tier1',
        pricingModel: 'per_unit',
        unitPrice: 4000,
        rates: { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
        isBillable: true,
        effectiveFrom: at,
      });
      const before = await specPricingService.quote(
        RESOURCES_8C16G20G,
        new Date(at.getTime() - 1),
      );
      const after = await specPricingService.quote(RESOURCES_8C16G20G, at);
      expect(before.hourlyCredits).toBe(820);
      expect(after.hourlyCredits).toBe(820 + 4 * 25);
    });

    it('T-SPQ8: 默认价目常量与默认价播种一致', async () => {
      const prices = await specPricingService.unitPrices();
      expect(prices).toEqual(DEFAULT_SPEC_UNIT_PRICES);
    });
  });
});
