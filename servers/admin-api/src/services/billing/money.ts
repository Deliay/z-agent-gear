/**
 * 资金整数运算工具：全链路以「分」为最小单位（0.01 credits = 1 分）。
 * 代码层禁止浮点直接参与资金计算；边界（GraphQL/HTTP）才做 credits ↔ 分换算。
 */

export const CENTS_PER_CREDIT = 100;
export const TOKENS_PER_MILLION = 1_000_000;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** credits → 分（仅边界使用；四舍五入到整数分）。 */
export function creditsToCents(credits: number): number {
  if (!Number.isFinite(credits)) throw new MoneyError(`invalid credits value: ${credits}`);
  const scaled = credits * CENTS_PER_CREDIT;
  // A7：极大有限 Float 乘 100 会溢出为 Infinity，必须乘后校验并限制安全整数上界。
  if (!Number.isFinite(scaled) || !Number.isSafeInteger(Math.round(scaled))) {
    throw new MoneyError(`credits value out of range: ${credits}`);
  }
  return Math.round(scaled);
}

/** 分 → credits（仅边界展示使用）。 */
export function centsToCredits(cents: number): number {
  if (!Number.isFinite(cents)) throw new MoneyError(`invalid cents value: ${cents}`);
  const rounded = Math.round(cents);
  if (!Number.isSafeInteger(rounded)) throw new MoneyError(`cents value out of range: ${cents}`);
  return rounded / CENTS_PER_CREDIT;
}

/** 充值金额校验：必须为正、最多 2 位小数（0.01 credits 精度）。 */
export function parseRechargeCents(credits: number): number {
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new MoneyError('充值金额必须为正数');
  }
  const scaled = credits * CENTS_PER_CREDIT;
  if (!Number.isFinite(scaled)) {
    throw new MoneyError('充值金额超出允许范围');
  }
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new MoneyError('充值金额最多支持 0.01 credits 精度');
  }
  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new MoneyError('充值金额必须为正数');
  return cents;
}

/** token 计费：tokens × 分/百万 token，不足 1 分按 1 分（向上取整）。
 * 输入为整数，避免浮点误差。
 *
 * 注意：这是**单段**计费。整单多段（输入/缓存/输出）请用 `allocateTokenCostCents`，
 * 否则每段各自 ceil 会造成整单多收（例如 1+1 token 会被收 2~3 分）。
 */
export function tokenCostCents(tokens: number, ratePerMillionCents: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(ratePerMillionCents)) {
    throw new MoneyError('token 计费参数非法');
  }
  if (tokens <= 0 || ratePerMillionCents <= 0) return 0;
  const cost = Math.ceil((tokens * ratePerMillionCents) / TOKENS_PER_MILLION);
  if (!Number.isFinite(cost) || !Number.isSafeInteger(cost)) {
    throw new MoneyError('token 计费金额超出安全范围');
  }
  return cost;
}

/**
 * 整单 token 计费：对多段按「先求和再向上取整」计算，并把结果按最大余数法分配到各段，
 * 保证各段金额之和 == 整单金额（且各段与精确值相差 ≤ 1 分）。
 *
 * `numerators[i] = tokens_i × rate_i`（整数分·百万 token 的分子），分母固定 1e6。
 */
export function allocateTokenCostCents(numerators: readonly number[]): number[] {
  const denominator = TOKENS_PER_MILLION;
  const safe = numerators.map((value) => {
    if (!Number.isFinite(value) || value < 0) throw new MoneyError('token 计费参数非法');
    if (!Number.isSafeInteger(value)) throw new MoneyError('token 计费金额超出安全范围');
    return value;
  });
  const totalNumerator = safe.reduce((acc, value) => acc + value, 0);
  if (!Number.isSafeInteger(totalNumerator)) throw new MoneyError('token 计费金额超出安全范围');
  if (totalNumerator <= 0) return safe.map(() => 0);
  const totalCents = Math.ceil(totalNumerator / denominator);
  const bases = safe.map((value) => Math.floor(value / denominator));
  const remainders = safe.map((value) => value % denominator);
  let remaining = totalCents - bases.reduce((acc, value) => acc + value, 0);
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const result = [...bases];
  for (const { index } of order) {
    if (remaining <= 0) break;
    result[index] = (result[index] ?? 0) + 1;
    remaining -= 1;
  }
  return result;
}

/** 容器分钟计费：分钟数 × 分/分钟（分钟数已由计量层向上取整）。 */
export function unitCostCents(quantity: number, unitPriceCents: number): number {
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPriceCents)) {
    throw new MoneyError('单价计费参数非法');
  }
  if (quantity <= 0 || unitPriceCents <= 0) return 0;
  const cost = Math.ceil(quantity * unitPriceCents);
  if (!Number.isFinite(cost) || !Number.isSafeInteger(cost)) {
    throw new MoneyError('单价计费金额超出安全范围');
  }
  return cost;
}

/** 向上取整到分钟（不足 1 分钟按 1 分钟）。 */
export function ceilMinutes(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 60_000);
}

export function sumCents(values: readonly number[]): number {
  return values.reduce((acc, value) => acc + Math.round(value), 0);
}

/** 可用余额 = 现金 + 赠送 + 授信 - 冻结（整数分）。 */
export function availableCents(account: {
  cashBalance: number;
  giftBalance?: number | null;
  creditLimit?: number | null;
  frozenAmount?: number | null;
}): number {
  return (
    Math.round(account.cashBalance) +
    Math.round(account.giftBalance ?? 0) +
    Math.round(account.creditLimit ?? 0) -
    Math.round(account.frozenAmount ?? 0)
  );
}
