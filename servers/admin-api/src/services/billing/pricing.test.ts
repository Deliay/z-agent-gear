import { describe, it, expect, vi } from 'vitest';

vi.mock('../../models/product-price.js', () => ({
  ProductPrice: { findOne: vi.fn(), updateOne: vi.fn() },
}));

import { ProductPrice } from '../../models/product-price.js';
import { PricingService } from './pricing.js';

function mockPrice(overrides: Record<string, unknown>) {
  return {
    productId: 'model.gpt-5.token',
    productName: 'gpt-5',
    pricingModel: 'per_token',
    unitPrice: 0,
    rates: { inputPerMillion: 100, cachedInputPerMillion: 50, outputPerMillion: 400 },
    isBillable: true,
    effectiveFrom: new Date(0),
    ...overrides,
  };
}

describe('PricingService（用量 × 价目 → 费用，单价快照）', () => {
  it('T-B3: 取生效档（effectiveFrom <= 消费时间的最新档）', async () => {
    const findOne = ProductPrice.findOne as unknown as ReturnType<typeof vi.fn>;
    const lean = vi.fn().mockResolvedValue(mockPrice({}));
    findOne.mockReturnValue({ sort: () => ({ lean }) } as never);
    const service = new PricingService();
    const price = await service.getPrice('model.gpt-5.token', new Date());
    expect(price?.rates.inputPerMillion).toBe(100);
    expect(findOne).toHaveBeenCalledWith({
      productId: 'model.gpt-5.token',
      effectiveFrom: { $lte: expect.any(Date) },
    });
  });

  it('T-B3/B8: 模型三段计价并在缓存输入上避免重复计费', async () => {
    const service = new PricingService();
    const findOne = ProductPrice.findOne as unknown as ReturnType<typeof vi.fn>;
    const lean = vi.fn().mockResolvedValue(mockPrice({}));
    findOne.mockReturnValue({ sort: () => ({ lean }) } as never);

    const priced = await service.priceModel(
      'gpt-5',
      { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 2000 },
      new Date(),
    );
    // 非缓存输入 600 × 100/1e6 = 0.06 分 → 1 分；缓存 400 × 50/1e6 → 1 分；输出 2000 × 400/1e6 = 0.8 分 → 1 分
    expect(priced.amountCents).toBe(3);
    expect(priced.items.map((item) => item.segment)).toEqual(['input', 'cached_input', 'output']);
  });

  it('容器缺价目时回落 1 credit/分钟，保证不漏计', async () => {
    const findOne = ProductPrice.findOne as unknown as ReturnType<typeof vi.fn>;
    const lean = vi.fn().mockResolvedValue(null);
    findOne.mockReturnValue({ sort: () => ({ lean }) } as never);
    const service = new PricingService();
    const priced = await service.priceContainer(3, new Date());
    expect(priced.amountCents).toBe(300);
    expect(priced.snapshot).toBeNull();
  });
});
