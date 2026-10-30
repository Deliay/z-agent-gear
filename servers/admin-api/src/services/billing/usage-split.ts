/**
 * 中断调用（`model_call.aborted`）输入 token 的 20/80 拆分规则——**唯一源**。
 *
 * Issue #355 口径：中断的请求，输入 token 按 20% 未缓存 + 80% 已缓存计费，输出依然是全价。
 * 计量层（`metering.ts` 固化 `dims.billedInput*`）、出账层（`billing-service.ts` 定价口径替换）、
 * 网关层（`billing-openai.ts` 审计成本直算）三处一律调用本函数，**禁止各自内联复制口径**。
 *
 * 取整规则：`cachedTokens = round(input × 0.8)`，`nonCachedTokens = input − cachedTokens`，
 * 保证两段之和恰为输入总量（不重不漏），取整余量归未缓存段（更贵的段，保守少让利方向）。
 */
export const ABORTED_INPUT_CACHED_RATIO = 0.8;

export interface AbortedInputSplit {
  /** 20% 侧：按未缓存输入单价计价。 */
  nonCachedTokens: number;
  /** 80% 侧：按缓存输入单价计价。 */
  cachedTokens: number;
}

/** 入参归一：非有限数归 0、负数归 0、小数截断为整数 token。 */
function normalizeTokenCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * 拆分中断调用的输入 token。
 *
 * 纯函数、确定性，只依赖入参，因此「事件 → 计量 → 定价」重放永远得到同一结果。
 * 边界：`input=0 → (0,0)`；`input=1 → (0,1)`（为 0 的段由 `pricing.ts` 既有零段过滤处理）。
 */
export function splitAbortedInput(inputTokens: number): AbortedInputSplit {
  const total = normalizeTokenCount(inputTokens);
  const cachedTokens = Math.round(total * ABORTED_INPUT_CACHED_RATIO);
  return { nonCachedTokens: total - cachedTokens, cachedTokens };
}
