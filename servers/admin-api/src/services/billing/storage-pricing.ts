import { logger as rootLogger } from '../../observability/logger.js';
import { centsToCredits } from './money.js';
import {
  CLOUD_STORAGE_BASE_PRODUCT_ID,
  CLOUD_STORAGE_TIER1_PRODUCT_ID,
  CLOUD_STORAGE_TIER2_PRODUCT_ID,
  DEFAULT_CLOUD_STORAGE_BASE_CENTS,
  DEFAULT_CLOUD_STORAGE_TIER1_CENTS,
  DEFAULT_CLOUD_STORAGE_TIER2_CENTS,
  PricingService,
  pricingService,
} from './pricing.js';

const logger = rootLogger.child({ component: 'billing-storage-pricing' });

export const STORAGE_MIN_SIZE_GI = 1;
export const STORAGE_MAX_SIZE_GI = 30;
/** 10~25Gi 档的起点（前 10Gi 走固定档）。 */
const TIER1_START_GI = 10;
/** 25~30Gi 档的起点。 */
const TIER2_START_GI = 25;

/** 三档价目单价（分/单位）。 */
export interface StorageUnitPrices {
  baseCents: number;
  tier1Cents: number;
  tier2Cents: number;
}

export const DEFAULT_STORAGE_UNIT_PRICES: StorageUnitPrices = {
  baseCents: DEFAULT_CLOUD_STORAGE_BASE_CENTS,
  tier1Cents: DEFAULT_CLOUD_STORAGE_TIER1_CENTS,
  tier2Cents: DEFAULT_CLOUD_STORAGE_TIER2_CENTS,
};

export interface StorageQuoteItem {
  productId: string;
  quantity: number;
  /** 单位（分）。 */
  unitPrice: number;
  /** 金额（分）。 */
  amount: number;
}

export interface StorageRateQuote {
  /** 每小时费用（分）。 */
  hourlyCents: number;
  /** 每小时费用（credits，仅边界展示）。 */
  hourlyCredits: number;
  items: StorageQuoteItem[];
}

export interface StorageHourlyQuote {
  sizeGi: number;
  full: StorageRateQuote;
  archived: StorageRateQuote;
}

/** 校验容量：整数且 1..30 Gi。 */
export function assertStorageSizeGi(sizeGi: number): number {
  if (
    !Number.isFinite(sizeGi) ||
    !Number.isInteger(sizeGi) ||
    sizeGi < STORAGE_MIN_SIZE_GI ||
    sizeGi > STORAGE_MAX_SIZE_GI
  ) {
    throw new RangeError('storage size must be between 1 and 30 Gi');
  }
  return sizeGi;
}

/**
 * 累计分档计价（纯函数，单位分）：
 * - base  = 前 10Gi 固定档（数量 1）；
 * - tier1 = max(0, min(sizeGi, 25) - 10) × 每 Gi 单价；
 * - tier2 = max(0, sizeGi - 25) × 每 Gi 单价；
 * - 归档半价 = 各档单价/金额减半（默认价目均为 100 的整数倍，恒为整数分）。
 */
export function quoteStorageHourly(
  sizeGi: number,
  prices: StorageUnitPrices = DEFAULT_STORAGE_UNIT_PRICES,
): StorageHourlyQuote {
  const size = assertStorageSizeGi(sizeGi);
  const tier1Quantity = Math.max(0, Math.min(size, TIER2_START_GI) - TIER1_START_GI);
  const tier2Quantity = Math.max(0, size - TIER2_START_GI);
  const fullItems: StorageQuoteItem[] = [
    {
      productId: CLOUD_STORAGE_BASE_PRODUCT_ID,
      quantity: 1,
      unitPrice: prices.baseCents,
      amount: prices.baseCents,
    },
    {
      productId: CLOUD_STORAGE_TIER1_PRODUCT_ID,
      quantity: tier1Quantity,
      unitPrice: prices.tier1Cents,
      amount: tier1Quantity * prices.tier1Cents,
    },
    {
      productId: CLOUD_STORAGE_TIER2_PRODUCT_ID,
      quantity: tier2Quantity,
      unitPrice: prices.tier2Cents,
      amount: tier2Quantity * prices.tier2Cents,
    },
  ].filter((item) => item.quantity > 0);

  const archivedItems: StorageQuoteItem[] = fullItems.map((item) => {
    // 半价取整：单价向下取整到「分」，金额 = quantity × 半价单价，保证明细合计与账单金额一致、
    // 且不出现小数分（money.ts：分是最小单位）。默认价目均为 100 的整数倍，行为不变。
    const unitPrice = Math.floor(item.unitPrice / 2);
    return {
      productId: item.productId,
      quantity: item.quantity,
      unitPrice,
      amount: item.quantity * unitPrice,
    };
  });

  const fullCents = fullItems.reduce((acc, item) => acc + item.amount, 0);
  const archivedCents = archivedItems.reduce((acc, item) => acc + item.amount, 0);
  return {
    sizeGi: size,
    full: {
      hourlyCents: fullCents,
      hourlyCredits: centsToCredits(fullCents),
      items: fullItems,
    },
    archived: {
      hourlyCents: archivedCents,
      hourlyCredits: centsToCredits(archivedCents),
      items: archivedItems,
    },
  };
}

/**
 * 读取 `productprices` 三档价目并组合报价；缺档（或非正价）回退默认价并 warn，
 * 保证不漏计（计费不可用不能变成免费）。
 */
export class StoragePricingService {
  constructor(
    private readonly prices: PricingService = pricingService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async unitPriceCents(
    productId: string,
    fallbackCents: number,
    at: Date,
  ): Promise<number> {
    const snapshot = await this.prices.getPrice(productId, at);
    if (snapshot && snapshot.unitPrice > 0) return snapshot.unitPrice;
    logger.warn(
      { productId, fallbackCents },
      '[billing] storage price missing; using fallback price',
    );
    return fallbackCents;
  }

  async quote(sizeGi: number, at: Date = new Date(this.now())): Promise<StorageHourlyQuote> {
    const size = assertStorageSizeGi(sizeGi);
    const [baseCents, tier1Cents, tier2Cents] = await Promise.all([
      this.unitPriceCents(CLOUD_STORAGE_BASE_PRODUCT_ID, DEFAULT_CLOUD_STORAGE_BASE_CENTS, at),
      this.unitPriceCents(CLOUD_STORAGE_TIER1_PRODUCT_ID, DEFAULT_CLOUD_STORAGE_TIER1_CENTS, at),
      this.unitPriceCents(CLOUD_STORAGE_TIER2_PRODUCT_ID, DEFAULT_CLOUD_STORAGE_TIER2_CENTS, at),
    ]);
    return quoteStorageHourly(size, { baseCents, tier1Cents, tier2Cents });
  }
}

export const storagePricingService = new StoragePricingService();
