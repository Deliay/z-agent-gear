/**
 * D-3：收据「用量与单价」的展示口径。
 *
 * 账单里同时存在两类明细：
 * - 容器：`quantity` 为分钟、`unitPrice` 为 credits/分钟，`量 × 单价 = 金额` 成立；
 * - 模型：`quantity` 为 token、`unitPrice` 为 credits/百万 token，
 *   `金额 = ceil(tokens × 单价 / 1e6)`，**不能**直接写成 `量 × 单价 = 金额`。
 */

export interface ReceiptItemLike {
  productId: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  segment?: string | null;
}

export function isTokenItem(item: Pick<ReceiptItemLike, 'productId'>): boolean {
  return item.productId.endsWith('.token') || item.productId.includes('.token.');
}

export function unitLabel(item: Pick<ReceiptItemLike, 'productId'>): string {
  return isTokenItem(item) ? 'credits/百万 token' : 'credits/分钟';
}

export function formatUnitPrice(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1) return value.toFixed(2);
  if (abs >= 0.000001) {
    return value
      .toFixed(6)
      .replace(/0+$/, '')
      .replace(/\.$/, '');
  }
  return value.toExponential(2);
}

export function itemFormula(item: ReceiptItemLike): string {
  if (isTokenItem(item)) {
    return `${item.quantity} tokens × ${formatUnitPrice(item.unitPrice)}/1e6 ≈ ${item.amount.toFixed(2)} credits`;
  }
  return `${item.quantity} × ${formatUnitPrice(item.unitPrice)} = ${item.amount.toFixed(2)} credits`;
}

export function segmentLabel(segment?: string | null): string {
  if (!segment) return '';
  // 中断调用的三段明细带 `:aborted` 后缀；剥离后缀按基础段名展示，避免两段输入同名为「中断」。
  const abortedSuffix = ':aborted';
  const aborted = segment.endsWith(abortedSuffix);
  const base = aborted ? segment.slice(0, -abortedSuffix.length) : segment;
  const label =
    base === 'input'
      ? '输入'
      : base === 'cached_input'
        ? '缓存输入'
        : base === 'output'
          ? '输出'
          : base === 'aborted'
            ? '中断'
            : base;
  if (aborted) return `${label}（中断）`;
  return label;
}
