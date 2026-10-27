import { ProductPrice, type IProductPrice } from '../../models/product-price.js';
import { Model } from '../../models/model.js';
import { allocateTokenCostCents, unitCostCents } from './money.js';

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
  /** 是否参与计费（false 时网关/管线均不扣费）。 */
  isBillable?: boolean;
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
/** 云电脑创建一次性费用：5 credits（价目档存在时不覆盖既有调价）。 */
export const DEFAULT_CLOUD_HOST_CREATE_CENTS = 500;

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
    await ProductPrice.updateOne(
      { productId: 'cloud_host.create' },
      {
        $setOnInsert: {
          productId: 'cloud_host.create',
          productName: '云电脑创建（一次性）',
          pricingModel: 'per_unit',
          unitPrice: DEFAULT_CLOUD_HOST_CREATE_CENTS,
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
      isBillable: doc.isBillable !== false,
    };
  }

  /**
   * A-4：价目双源兜底。网关预检读 `models.pricing`，计费管线读 `productprices`；
   * 若某条路径只写了前者（模型创建/导入/直改库），管线会 amountCents=0 导致「消费免费」。
   * 这里在 productprices 缺档时回落 `models.pricing`（与预检同价源），保证两边口径一致。
   */
  private async modelPricingFallback(modelId: string, at: Date): Promise<PriceSnapshot | null> {
    if (!modelId) return null;
    const query = /^[a-f0-9]{24}$/i.test(modelId)
      ? { _id: modelId }
      : { name: modelId, scope: 'global' as const };
    const model = await Model.findOne(query)
      .select({ name: 1, pricing: 1 })
      .lean<{ name?: string; pricing?: { inputPerMillion?: number; cachedInputPerMillion?: number; outputPerMillion?: number; isBillable?: boolean } | null } | null>();
    if (!model?.pricing) return null;
    const rates = {
      inputPerMillion: Math.round(model.pricing.inputPerMillion ?? 0),
      cachedInputPerMillion: Math.round(model.pricing.cachedInputPerMillion ?? 0),
      outputPerMillion: Math.round(model.pricing.outputPerMillion ?? 0),
    };
    const hasRate =
      rates.inputPerMillion > 0 || rates.cachedInputPerMillion > 0 || rates.outputPerMillion > 0;
    if (!hasRate && model.pricing.isBillable !== false) return null;
    return {
      productId: `model.${modelId}.token`,
      productName: model.name ?? modelId,
      pricingModel: 'per_token',
      unitPrice: 0,
      rates,
      effectiveFrom: at,
      isBillable: model.pricing.isBillable !== false,
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
    let snapshot = await this.getPrice(`model.${modelId}.token`, at);
    const hasRate = (value: PricedUsage['snapshot']): boolean =>
      !!value &&
      (value.rates.inputPerMillion > 0 ||
        value.rates.cachedInputPerMillion > 0 ||
        value.rates.outputPerMillion > 0);
    if (!snapshot || (!hasRate(snapshot) && snapshot.isBillable !== false)) {
      // A-4/R2-4：productprices **无档**或**全 0 档**时回落 `models.pricing`，避免
      // 「只写 model.pricing」或「价目档全 0」时静默免费；回落仍无有效费率时由调用方告警。
      const fallback = await this.modelPricingFallback(modelId, at);
      if (fallback) snapshot = fallback;
    }
    if (snapshot?.isBillable === false) {
      return { amountCents: 0, items: [], snapshot };
    }
    const rates = snapshot?.rates ?? { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 };
    const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
    const nonCachedInput = Math.max(0, usage.inputTokens - cached);
    // 整单计费（建议）：三段先各自算「分子」，求和后统一 ceil，
    // 再按最大余数法分配，避免每段各自 ceil 导致整单多收。
    const numerators = [
      Math.max(0, Math.round(nonCachedInput)) * Math.max(0, Math.round(rates.inputPerMillion)),
      Math.max(0, Math.round(cached)) * Math.max(0, Math.round(rates.cachedInputPerMillion)),
      Math.max(0, Math.round(usage.outputTokens)) * Math.max(0, Math.round(rates.outputPerMillion)),
    ];
    const amounts = allocateTokenCostCents(numerators);
    const items: PricingItem[] = [
      {
        productId: `model.${modelId}.token.input`,
        quantity: nonCachedInput,
        unitPrice: rates.inputPerMillion,
        amount: amounts[0] ?? 0,
        segment: 'input',
      },
      {
        productId: `model.${modelId}.token.cached_input`,
        quantity: cached,
        unitPrice: rates.cachedInputPerMillion,
        amount: amounts[1] ?? 0,
        segment: 'cached_input',
      },
      {
        productId: `model.${modelId}.token.output`,
        quantity: usage.outputTokens,
        unitPrice: rates.outputPerMillion,
        amount: amounts[2] ?? 0,
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
