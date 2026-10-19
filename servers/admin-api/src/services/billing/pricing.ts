import { ProductPrice, type IProductPrice } from '../../models/product-price.js';
import { tokenCostCents, unitCostCents } from './money.js';

export interface PriceSnapshot {
  productId: string;
  productName: string;
  pricingModel: 'per_unit' | 'per_token';
  unitPrice: number;
  rates: {
    inputPerMillion: number;
    cachedInputPerMillion: number;
    outputPerMillion: number;
  };
  effectiveFrom: Date;
}

export interface PricingItem {
  productId: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  segment: string | null;
}

export interface PricedUsage {
  amountCents: number;
  items: PricingItem[];
  snapshot: PriceSnapshot | null;
}

const DEFAULT_CONTAINER_MINUTE_CENTS = 100; // 1 credit / 分钟

/** 定价：按消费时段取生效价目（effectiveFrom <= at 的最新档），产出单价快照。 */
export class PricingService {
  async ensureDefaultPrices(): Promise<void> {
    await ProductPrice.updateOne(
      { productId: 'container.minute' },
      {
        $setOnInsert: {
          productId: 'container.minute',
          productName: '云端工作容器（分钟）',
          pricingModel: 'per_unit',
          unitPrice: DEFAULT_CONTAINER_MINUTE_CENTS,
          rates: { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 },
          isBillable: true,
          effectiveFrom: new Date(0),
        },
      },
      { upsert: true },
    );
  }

  async getPrice(productId: string, at: Date): Promise<PriceSnapshot | null> {
    const doc = await ProductPrice.findOne({ productId, effectiveFrom: { $lte: at } })
      .sort({ effectiveFrom: -1 })
      .lean<IProductPrice | null>();
    if (!doc) return null;
    return {
      productId: doc.productId,
      productName: doc.productName ?? doc.productId,
      pricingModel: (doc.pricingModel as 'per_unit' | 'per_token') ?? 'per_unit',
      unitPrice: doc.unitPrice ?? 0,
      rates: {
        inputPerMillion: doc.rates?.inputPerMillion ?? 0,
        cachedInputPerMillion: doc.rates?.cachedInputPerMillion ?? 0,
        outputPerMillion: doc.rates?.outputPerMillion ?? 0,
      },
      effectiveFrom: doc.effectiveFrom ?? new Date(0),
    };
  }

  /** 容器：分钟数 × 分/分钟。缺价目时回落 1 credit/分钟（保证不漏计）。 */
  async priceContainer(minutes: number, at: Date): Promise<PricedUsage> {
    const snapshot = await this.getPrice('container.minute', at);
    const unitPrice = snapshot?.unitPrice ?? DEFAULT_CONTAINER_MINUTE_CENTS;
    const amount = unitCostCents(minutes, unitPrice);
    return {
      amountCents: amount,
      snapshot,
      items: [
        {
          productId: 'container.minute',
          quantity: minutes,
          unitPrice,
          amount,
          segment: null,
        },
      ],
    };
  }

  /**
   * 模型：输入（非缓存部分）/ 缓存输入 / 输出三段分别计价。
   * 缓存 token 是输入 token 的子集，计价时从输入中扣除，避免重复计费。
   */
  async priceModel(
    modelId: string,
    usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
    at: Date,
  ): Promise<PricedUsage> {
    const snapshot = await this.getPrice(`model.${modelId}.token`, at);
    const rates = snapshot?.rates ?? { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 };
    const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
    const nonCachedInput = Math.max(0, usage.inputTokens - cached);
    const items: PricingItem[] = [
      {
        productId: `model.${modelId}.token.input`,
        quantity: nonCachedInput,
        unitPrice: rates.inputPerMillion,
        amount: tokenCostCents(nonCachedInput, rates.inputPerMillion),
        segment: 'input',
      },
      {
        productId: `model.${modelId}.token.cached_input`,
        quantity: cached,
        unitPrice: rates.cachedInputPerMillion,
        amount: tokenCostCents(cached, rates.cachedInputPerMillion),
        segment: 'cached_input',
      },
      {
        productId: `model.${modelId}.token.output`,
        quantity: usage.outputTokens,
        unitPrice: rates.outputPerMillion,
        amount: tokenCostCents(usage.outputTokens, rates.outputPerMillion),
        segment: 'output',
      },
    ].filter((item) => item.quantity > 0 || item.amount > 0);
    return {
      amountCents: items.reduce((acc, item) => acc + item.amount, 0),
      items,
      snapshot,
    };
  }
}

export const pricingService = new PricingService();
