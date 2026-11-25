import { logger as rootLogger } from '../../observability/logger.js';
import { centsToCredits } from './money.js';
import {
  CLOUD_SPEC_CPU_TIER1_PRODUCT_ID,
  CLOUD_SPEC_CPU_TIER2_PRODUCT_ID,
  CLOUD_SPEC_EPHEMERAL_TIER_PRODUCT_ID,
  CLOUD_SPEC_MEM_TIER1_PRODUCT_ID,
  CLOUD_SPEC_MEM_TIER2_PRODUCT_ID,
  CLOUD_SPEC_MEM_TIER3_PRODUCT_ID,
  CLOUD_SPEC_MEM_TIER4_PRODUCT_ID,
  DEFAULT_CLOUD_SPEC_CPU_TIER1_CENTS,
  DEFAULT_CLOUD_SPEC_CPU_TIER2_CENTS,
  DEFAULT_CLOUD_SPEC_EPHEMERAL_TIER_CENTS,
  DEFAULT_CLOUD_SPEC_MEM_TIER1_CENTS,
  DEFAULT_CLOUD_SPEC_MEM_TIER2_CENTS,
  DEFAULT_CLOUD_SPEC_MEM_TIER3_CENTS,
  DEFAULT_CLOUD_SPEC_MEM_TIER4_CENTS,
  PricingService,
  pricingService,
} from './pricing.js';

const logger = rootLogger.child({ component: 'billing-spec-pricing' });

export const SPEC_MAX_CPU = 64;
export const SPEC_MAX_MEMORY_GI = 256;
export const SPEC_MAX_EPHEMERAL_STORAGE_GI = 512;
/** CPU 第一档上限（≤4 部分）。 */
const CPU_TIER2_START = 4;
/** 临时存储免费额度（≤10GiB 不收费）。 */
const EPHEMERAL_FREE_GI = 10;

/** 规格资源量（计费与下发共用口径）。 */
export interface SpecResources {
  cpu: number;
  memoryGi: number;
  ephemeralStorageGi: number;
}

/** 全零 = 不限制容器（唯一允许含 0 的组合）。 */
export function isUnlimitedSpec(spec: Pick<SpecResources, 'cpu' | 'memoryGi' | 'ephemeralStorageGi'>): boolean {
  return spec.cpu === 0 && spec.memoryGi === 0 && spec.ephemeralStorageGi === 0;
}

/**
 * 校验规格组合：三项均为整数且在 0..上限；全零或全正（除全零外任何含 0 组合拒绝）。
 * 合法返回归一后的资源量，非法抛 `RangeError('invalid spec resources')`。
 */
export function assertSpecResources(input: SpecResources): SpecResources {
  const values = [input.cpu, input.memoryGi, input.ephemeralStorageGi];
  if (values.some((value) => !Number.isInteger(value))) {
    throw new RangeError('invalid spec resources');
  }
  if (
    input.cpu < 0 ||
    input.cpu > SPEC_MAX_CPU ||
    input.memoryGi < 0 ||
    input.memoryGi > SPEC_MAX_MEMORY_GI ||
    input.ephemeralStorageGi < 0 ||
    input.ephemeralStorageGi > SPEC_MAX_EPHEMERAL_STORAGE_GI
  ) {
    throw new RangeError('invalid spec resources');
  }
  if (isUnlimitedSpec(input)) return { ...input };
  if (input.cpu < 1 || input.memoryGi < 1 || input.ephemeralStorageGi < 1) {
    throw new RangeError('invalid spec resources');
  }
  return { ...input };
}

/** 七档价目单价（分/单位/小时）。 */
export interface SpecUnitPrices {
  cpuTier1Cents: number;
  cpuTier2Cents: number;
  memTier1Cents: number;
  memTier2Cents: number;
  memTier3Cents: number;
  memTier4Cents: number;
  ephemeralTierCents: number;
}

export const DEFAULT_SPEC_UNIT_PRICES: SpecUnitPrices = {
  cpuTier1Cents: DEFAULT_CLOUD_SPEC_CPU_TIER1_CENTS,
  cpuTier2Cents: DEFAULT_CLOUD_SPEC_CPU_TIER2_CENTS,
  memTier1Cents: DEFAULT_CLOUD_SPEC_MEM_TIER1_CENTS,
  memTier2Cents: DEFAULT_CLOUD_SPEC_MEM_TIER2_CENTS,
  memTier3Cents: DEFAULT_CLOUD_SPEC_MEM_TIER3_CENTS,
  memTier4Cents: DEFAULT_CLOUD_SPEC_MEM_TIER4_CENTS,
  ephemeralTierCents: DEFAULT_CLOUD_SPEC_EPHEMERAL_TIER_CENTS,
};

export interface SpecQuoteItem {
  productId: string;
  quantity: number;
  /** 单位（分）。 */
  unitPrice: number;
  /** 金额（分）。 */
  amount: number;
  /** 展示文案（分档口径）。 */
  label: string;
}

export interface SpecQuoteTier {
  label: string;
  amountCredits: number;
}

export interface SpecRateQuote {
  /** 每小时费用（分）。 */
  hourlyCents: number;
  /** 每小时费用（credits）。 */
  hourlyCredits: number;
  items: SpecQuoteItem[];
  tiers: SpecQuoteTier[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatCents(unitPrice: number): string {
  return String(centsToCredits(unitPrice));
}

/**
 * 七档超额累进计价（纯函数，单位分）：
 * - CPU：≤4 部分 × tier1 + >4 部分 × tier2；
 * - 内存：≤4 / 4~8 / 8~16 / >16 四段累进；
 * - 临时存储：>10GiB 部分 × 单价（≤10GiB 免费）；
 * - 全零规格恒 0（无 items/tiers）。
 *
 * 示例（8C 16G 20G，默认价目）：CPU 4×1500+4×3000=18000；
 * 内存 4×1500+4×3000+8×4500=54000；临时存储 10×1000=10000 → 合计 82000 分 = 820 credits/小时。
 */
export function quoteSpecHourly(
  spec: SpecResources,
  prices: SpecUnitPrices = DEFAULT_SPEC_UNIT_PRICES,
): SpecRateQuote {
  const resources = assertSpecResources(spec);
  if (isUnlimitedSpec(resources)) {
    return { hourlyCents: 0, hourlyCredits: 0, items: [], tiers: [] };
  }

  const cpuTier1Quantity = Math.min(resources.cpu, CPU_TIER2_START);
  const cpuTier2Quantity = Math.max(0, resources.cpu - CPU_TIER2_START);
  const memTier1Quantity = Math.min(resources.memoryGi, 4);
  const memTier2Quantity = clamp(resources.memoryGi - 4, 0, 4);
  const memTier3Quantity = clamp(resources.memoryGi - 8, 0, 8);
  const memTier4Quantity = Math.max(0, resources.memoryGi - 16);
  const ephemeralQuantity = Math.max(0, resources.ephemeralStorageGi - EPHEMERAL_FREE_GI);

  const draft: Array<{ productId: string; quantity: number; unitPrice: number; kind: 'cpu' | 'mem' | 'eph' }> = [
    { productId: CLOUD_SPEC_CPU_TIER1_PRODUCT_ID, quantity: cpuTier1Quantity, unitPrice: prices.cpuTier1Cents, kind: 'cpu' },
    { productId: CLOUD_SPEC_CPU_TIER2_PRODUCT_ID, quantity: cpuTier2Quantity, unitPrice: prices.cpuTier2Cents, kind: 'cpu' },
    { productId: CLOUD_SPEC_MEM_TIER1_PRODUCT_ID, quantity: memTier1Quantity, unitPrice: prices.memTier1Cents, kind: 'mem' },
    { productId: CLOUD_SPEC_MEM_TIER2_PRODUCT_ID, quantity: memTier2Quantity, unitPrice: prices.memTier2Cents, kind: 'mem' },
    { productId: CLOUD_SPEC_MEM_TIER3_PRODUCT_ID, quantity: memTier3Quantity, unitPrice: prices.memTier3Cents, kind: 'mem' },
    { productId: CLOUD_SPEC_MEM_TIER4_PRODUCT_ID, quantity: memTier4Quantity, unitPrice: prices.memTier4Cents, kind: 'mem' },
    { productId: CLOUD_SPEC_EPHEMERAL_TIER_PRODUCT_ID, quantity: ephemeralQuantity, unitPrice: prices.ephemeralTierCents, kind: 'eph' },
  ];

  const items: SpecQuoteItem[] = draft
    .filter((entry) => entry.quantity > 0)
    .map((entry) => {
      const amount = entry.quantity * entry.unitPrice;
      const unit =
        entry.kind === 'cpu'
          ? `${entry.quantity} 核 × ${formatCents(entry.unitPrice)} credits/核/小时`
          : entry.kind === 'mem'
            ? `${entry.quantity} GiB × ${formatCents(entry.unitPrice)} credits/GiB/小时`
            : `${entry.quantity} GiB × ${formatCents(entry.unitPrice)} credits/GiB/小时`;
      const label = entry.kind === 'cpu' ? `CPU ${unit}` : entry.kind === 'mem' ? `内存 ${unit}` : `临时存储 ${unit}`;
      return {
        productId: entry.productId,
        quantity: entry.quantity,
        unitPrice: entry.unitPrice,
        amount,
        label,
      };
    });

  const hourlyCents = items.reduce((acc, item) => acc + item.amount, 0);
  return {
    hourlyCents,
    hourlyCredits: centsToCredits(hourlyCents),
    items,
    tiers: items.map((item) => ({
      label: item.label,
      amountCredits: centsToCredits(item.amount),
    })),
  };
}

/**
 * 读取 `productprices` 七档价目并组合报价；缺档（或非正价）回退默认价并 warn，
 * 保证不漏计（计费不可用不能变成免费）。
 */
export class SpecPricingService {
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
      '[billing] spec price missing; using fallback price',
    );
    return fallbackCents;
  }

  async unitPrices(at: Date = new Date(this.now())): Promise<SpecUnitPrices> {
    const [
      cpuTier1Cents,
      cpuTier2Cents,
      memTier1Cents,
      memTier2Cents,
      memTier3Cents,
      memTier4Cents,
      ephemeralTierCents,
    ] = await Promise.all([
      this.unitPriceCents(CLOUD_SPEC_CPU_TIER1_PRODUCT_ID, DEFAULT_CLOUD_SPEC_CPU_TIER1_CENTS, at),
      this.unitPriceCents(CLOUD_SPEC_CPU_TIER2_PRODUCT_ID, DEFAULT_CLOUD_SPEC_CPU_TIER2_CENTS, at),
      this.unitPriceCents(CLOUD_SPEC_MEM_TIER1_PRODUCT_ID, DEFAULT_CLOUD_SPEC_MEM_TIER1_CENTS, at),
      this.unitPriceCents(CLOUD_SPEC_MEM_TIER2_PRODUCT_ID, DEFAULT_CLOUD_SPEC_MEM_TIER2_CENTS, at),
      this.unitPriceCents(CLOUD_SPEC_MEM_TIER3_PRODUCT_ID, DEFAULT_CLOUD_SPEC_MEM_TIER3_CENTS, at),
      this.unitPriceCents(CLOUD_SPEC_MEM_TIER4_PRODUCT_ID, DEFAULT_CLOUD_SPEC_MEM_TIER4_CENTS, at),
      this.unitPriceCents(
        CLOUD_SPEC_EPHEMERAL_TIER_PRODUCT_ID,
        DEFAULT_CLOUD_SPEC_EPHEMERAL_TIER_CENTS,
        at,
      ),
    ]);
    return {
      cpuTier1Cents,
      cpuTier2Cents,
      memTier1Cents,
      memTier2Cents,
      memTier3Cents,
      memTier4Cents,
      ephemeralTierCents,
    };
  }

  async quote(spec: SpecResources, at: Date = new Date(this.now())): Promise<SpecRateQuote> {
    const resources = assertSpecResources(spec);
    if (isUnlimitedSpec(resources)) return quoteSpecHourly(resources);
    return quoteSpecHourly(resources, await this.unitPrices(at));
  }
}

export const specPricingService = new SpecPricingService();
