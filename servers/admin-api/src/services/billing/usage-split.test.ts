import { describe, it, expect } from 'vitest';
import { ABORTED_INPUT_CACHED_RATIO, splitAbortedInput } from './usage-split.js';

/**
 * T-AB1：中断输入 20/80 拆分不变量。
 * 规则「拆分唯一源」——计量 / 出账 / 网关三处共用，禁止各自内联口径。
 */
describe('splitAbortedInput（中断输入 20/80 拆分）', () => {
  it('比例常量为 0.8（80% 缓存 + 20% 未缓存）', () => {
    expect(ABORTED_INPUT_CACHED_RATIO).toBe(0.8);
  });

  it('T-AB1: 合法输入下两段之和恰为输入总量，缓存段取整、余量归未缓存段', () => {
    for (const input of [0, 1, 2, 3, 5, 7, 10, 999, 1_000_001, 123_456_789]) {
      const { nonCachedTokens, cachedTokens } = splitAbortedInput(input);
      expect(cachedTokens).toBe(Math.round(input * ABORTED_INPUT_CACHED_RATIO));
      expect(nonCachedTokens).toBe(input - cachedTokens);
      // 不重不漏：两段和恰为输入总量
      expect(nonCachedTokens + cachedTokens).toBe(input);
      // 取整余量归未缓存段（非负，且不超过 20% 的取整误差范围）
      expect(nonCachedTokens).toBeGreaterThanOrEqual(0);
      expect(cachedTokens).toBeGreaterThanOrEqual(0);
    }
  });

  it('T-AB1: 边界 0 / 1 token 的拆分结果', () => {
    expect(splitAbortedInput(0)).toEqual({ nonCachedTokens: 0, cachedTokens: 0 });
    // 1 token：80% 取整为 1，未缓存段为 0（该段不产生明细）
    expect(splitAbortedInput(1)).toEqual({ nonCachedTokens: 0, cachedTokens: 1 });
    expect(splitAbortedInput(5)).toEqual({ nonCachedTokens: 1, cachedTokens: 4 });
  });

  it('T-AB1: 入参归一——小数截断、负数与非有限数归 0', () => {
    expect(splitAbortedInput(10.9)).toEqual(splitAbortedInput(10));
    expect(splitAbortedInput(-5)).toEqual({ nonCachedTokens: 0, cachedTokens: 0 });
    expect(splitAbortedInput(Number.NaN)).toEqual({ nonCachedTokens: 0, cachedTokens: 0 });
    expect(splitAbortedInput(Number.POSITIVE_INFINITY)).toEqual({
      nonCachedTokens: 0,
      cachedTokens: 0,
    });
  });

  it('T-AB1: 纯函数确定性（同一入参重复调用结果一致）', () => {
    expect(splitAbortedInput(1234)).toEqual(splitAbortedInput(1234));
  });
});
