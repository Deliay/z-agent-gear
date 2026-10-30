import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/product-price.js', () => ({
  ProductPrice: { findOne: vi.fn(), updateOne: vi.fn() },
}));

vi.mock('../../models/model.js', () => ({
  Model: { findOne: vi.fn() },
}));

import { ProductPrice } from '../../models/product-price.js';
import { Model } from '../../models/model.js';
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    // 整单求和后向上取整：0.06 + 0.02 + 0.8 = 0.88 分 → 1 分（此前每段各自 ceil 会收 3 分）。
    expect(priced.amountCents).toBe(1);
    expect(priced.items.reduce((acc, item) => acc + item.amount, 0)).toBe(1);
    expect(priced.items.map((item) => item.segment)).toEqual(['input', 'cached_input', 'output']);
  });

  it('A-4: productprices 缺档时回落 models.pricing（避免消费免费）', async () => {
    const findOne = ProductPrice.findOne as unknown as ReturnType<typeof vi.fn>;
    findOne.mockReturnValue({ sort: () => ({ lean: vi.fn().mockResolvedValue(null) }) } as never);
    const modelFindOne = Model.findOne as unknown as ReturnType<typeof vi.fn>;
    modelFindOne.mockReturnValue({
      select: () => ({
        lean: vi.fn().mockResolvedValue({
          name: 'gpt-5',
          pricing: { inputPerMillion: 100, cachedInputPerMillion: 0, outputPerMillion: 100, isBillable: true },
        }),
      }),
    } as never);

    const service = new PricingService();
    const priced = await service.priceModel(
      '507f1f77bcf86cd799439011',
      { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
      new Date(),
    );
    expect(priced.snapshot).not.toBeNull();
    expect(priced.amountCents).toBe(100);
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

  it('R3-4: productprices 存在全 0 价目档时回落 models.pricing（不得静默免费）', async () => {
    const findOne = ProductPrice.findOne as unknown as ReturnType<typeof vi.fn>;
    findOne.mockReturnValue({
      sort: () => ({
        lean: vi.fn().mockResolvedValue(
          mockPrice({
            rates: { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
            isBillable: true,
          }),
        ),
      }),
    } as never);
    const modelFindOne = Model.findOne as unknown as ReturnType<typeof vi.fn>;
    modelFindOne.mockReturnValue({
      select: () => ({
        lean: vi.fn().mockResolvedValue({
          name: 'gpt-5',
          pricing: {
            inputPerMillion: 100,
            cachedInputPerMillion: 0,
            outputPerMillion: 100,
            isBillable: true,
          },
        }),
      }),
    } as never);

    const service = new PricingService();
    const priced = await service.priceModel(
      '507f1f77bcf86cd799439011',
      { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
      new Date(),
    );
    // 修复前（仅 `!snapshot` 才回落）：全 0 档命中 → 不回落 → amountCents=0（静默免费）。
    expect(modelFindOne).toHaveBeenCalled();
    expect(priced.amountCents).toBe(100);
  });

  it('R3-4: productprices 显式非计费档（isBillable:false）不回落且不计费', async () => {
    const findOne = ProductPrice.findOne as unknown as ReturnType<typeof vi.fn>;
    findOne.mockReturnValue({
      sort: () => ({ lean: vi.fn().mockResolvedValue(mockPrice({ isBillable: false })) }),
    } as never);
    const modelFindOne = Model.findOne as unknown as ReturnType<typeof vi.fn>;
    modelFindOne.mockReturnValue({
      select: () => ({
        lean: vi.fn().mockResolvedValue({
          name: 'gpt-5',
          pricing: { inputPerMillion: 100, cachedInputPerMillion: 0, outputPerMillion: 100, isBillable: true },
        }),
      }),
    } as never);

    const service = new PricingService();
    const priced = await service.priceModel(
      'gpt-5',
      { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
      new Date(),
    );
    expect(modelFindOne).not.toHaveBeenCalled();
    expect(priced.amountCents).toBe(0);
    expect(priced.items).toEqual([]);
  });

  it('T-AB8: 拆分输入（cached = 80%）的三段计价数量/金额正确，为 0 的段不产生明细', async () => {
    const findOne = ProductPrice.findOne as unknown as ReturnType<typeof vi.fn>;
    const lean = vi.fn().mockResolvedValue(mockPrice({}));
    findOne.mockReturnValue({ sort: () => ({ lean }) } as never);
    const service = new PricingService();

    // 拆分后：input=1_000_000，cachedInputTokens=800_000 → 未缓存段 200_000
    const priced = await service.priceModel(
      'gpt-5',
      { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 1_000_000 },
      new Date(),
    );
    const bySegment = new Map(priced.items.map((item) => [item.segment, item]));
    expect(bySegment.get('input')?.quantity).toBe(200_000);
    expect(bySegment.get('cached_input')?.quantity).toBe(800_000);
    expect(bySegment.get('output')?.quantity).toBe(1_000_000);
    // 200k×100 + 800k×50 + 1M×400 = 460000000 / 1e6 → 460 分
    expect(priced.amountCents).toBe(460);
    expect(priced.items.reduce((acc, item) => acc + item.amount, 0)).toBe(460);

    // 输入仅 1 token（拆分后 cached=1, nonCached=0）：未缓存段不产生明细
    const single = await service.priceModel(
      'gpt-5',
      { inputTokens: 1, cachedInputTokens: 1, outputTokens: 1 },
      new Date(),
    );
    expect(single.items.map((item) => item.segment)).toEqual(['cached_input', 'output']);
  });

  it('T-PRICE-C1: 初始化云电脑创建价目且不覆盖既有调价档', async () => {
    const updateOne = ProductPrice.updateOne as unknown as ReturnType<typeof vi.fn>;
    updateOne.mockResolvedValue({ acknowledged: true });
    await new PricingService().ensureDefaultPrices();
    const createCall = updateOne.mock.calls.find(
      ([filter]) => (filter as { productId?: string }).productId === 'cloud_host.create',
    );
    expect(createCall).toBeDefined();
    expect(createCall![1]).toMatchObject({
      $setOnInsert: { unitPrice: 500, isBillable: true, pricingModel: 'per_unit' },
    });
  });
});
