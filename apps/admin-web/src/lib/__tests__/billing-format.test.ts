import { describe, it, expect } from 'vitest';
import { segmentLabel } from '../billing-format';

/**
 * T-FE1：中断分段标签映射（与 agent-web 逐字同构）。
 * 20/80 拆分后 `input:aborted` 与 `cached_input:aborted` 必须可区分，且均带「中断」标注。
 */
describe('segmentLabel（中断分段标签）', () => {
  it('T-FE1: 中断三段各自展示并带「中断」标注', () => {
    expect(segmentLabel('input:aborted')).toBe('输入（中断）');
    expect(segmentLabel('cached_input:aborted')).toBe('缓存输入（中断）');
    expect(segmentLabel('output:aborted')).toBe('输出（中断）');
  });

  it('T-FE1: 无后缀段的既有展示零变化', () => {
    expect(segmentLabel('input')).toBe('输入');
    expect(segmentLabel('cached_input')).toBe('缓存输入');
    expect(segmentLabel('output')).toBe('输出');
  });

  it('T-FE1: 空值与未知段保持现状', () => {
    expect(segmentLabel(null)).toBe('');
    expect(segmentLabel(undefined)).toBe('');
    expect(segmentLabel('')).toBe('');
    expect(segmentLabel('aborted')).toBe('中断');
    expect(segmentLabel('unknown')).toBe('unknown');
  });
});
