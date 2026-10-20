import { describe, it, expect } from 'vitest';
import {
  allocateTokenCostCents,
  availableCents,
  ceilMinutes,
  centsToCredits,
  creditsToCents,
  parseRechargeCents,
  tokenCostCents,
  unitCostCents,
} from './money.js';

describe('money（整数分运算）', () => {
  it('T-B8: credits ↔ 分换算无浮点误差', () => {
    expect(creditsToCents(0.1) + creditsToCents(0.2)).toBe(30);
    expect(centsToCredits(30)).toBe(0.3);
    expect(creditsToCents(1)).toBe(100);
  });

  it('T-B8: token 计费向上取整到分，不产生浮点误差', () => {
    // 1 token × 100 分/百万 = 0.0001 分 → 向上取整 1 分
    expect(tokenCostCents(1, 100)).toBe(1);
    expect(tokenCostCents(1_000_000, 250)).toBe(250);
    expect(tokenCostCents(1_000_001, 100)).toBe(101);
    expect(tokenCostCents(0, 100)).toBe(0);
  });

  it('整单 token 计费：先求和再 ceil，各段分配之和等于整单', () => {
    // 60000 + 20000 + 800000 = 880000 分子 / 1e6 → 1 分（旧实现每段各自 ceil = 3 分）
    const amounts = allocateTokenCostCents([60000, 20000, 800000]);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(amounts).toEqual([0, 0, 1]);
    expect(allocateTokenCostCents([0, 0, 0])).toEqual([0, 0, 0]);
    // 1+1 token 各 100 分/百万 → 合计 0.0002 分 → 1 分
    const two = allocateTokenCostCents([100, 100]);
    expect(two.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('容器分钟计费：不足 1 分钟按 1 分钟', () => {
    expect(ceilMinutes(0)).toBe(0);
    expect(ceilMinutes(1)).toBe(1);
    expect(ceilMinutes(60_000)).toBe(1);
    expect(ceilMinutes(60_001)).toBe(2);
    expect(unitCostCents(3, 100)).toBe(300);
  });

  it('充值金额校验：正数 + 0.01 精度', () => {
    expect(parseRechargeCents(100)).toBe(10000);
    expect(parseRechargeCents(0.01)).toBe(1);
    expect(() => parseRechargeCents(0)).toThrow();
    expect(() => parseRechargeCents(-1)).toThrow();
    expect(() => parseRechargeCents(1.001)).toThrow();
  });

  it('available = cash + gift + creditLimit - frozen', () => {
    expect(availableCents({ cashBalance: 100, frozenAmount: 30, creditLimit: 50 })).toBe(120);
    expect(availableCents({ cashBalance: -500, creditLimit: 1000 })).toBe(500);
  });
});
