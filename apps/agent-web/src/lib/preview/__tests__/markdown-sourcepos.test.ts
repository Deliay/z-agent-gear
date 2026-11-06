// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  buildLineOffsets,
  parseSourcePos,
  sourcePosToOffsets,
  unionOffsets,
  mapSelectionToSource,
} from '../markdown-sourcepos.js';

const SOURCE = '# Title\n\nHello **world**\n\n- item\n';

describe('markdown-sourcepos（T-SPOS1~6）', () => {
  it('T-SPOS1 行内映射：offset 换算精确（endCol 开区间）', () => {
    const offsets = buildLineOffsets(SOURCE);
    expect(offsets).toEqual([0, 8, 9, 25, 26, 33]);
    const pos = parseSourcePos('3:1-3:6');
    expect(pos).toEqual({ startLine: 3, startCol: 1, endLine: 3, endCol: 6 });
    const range = sourcePosToOffsets(pos!, SOURCE, offsets);
    expect(range).toEqual({ startOffset: 9, endOffset: 14 });
    expect(SOURCE.slice(range!.startOffset, range!.endOffset)).toBe('Hello');
  });

  it('T-SPOS2 跨块并集：区间取最小闭包', () => {
    expect(
      unionOffsets({ startOffset: 10, endOffset: 15 }, { startOffset: 27, endOffset: 32 }),
    ).toEqual({ startOffset: 10, endOffset: 32 });
  });

  it('T-SPOS3 不可映射：无 sourcepos / 非法形态返回 null', () => {
    expect(parseSourcePos(null)).toBeNull();
    expect(parseSourcePos('')).toBeNull();
    expect(parseSourcePos('garbage')).toBeNull();
    expect(parseSourcePos('0:1-1:1')).toBeNull();
    expect(mapSelectionToSource('3:1-3:6', null, SOURCE)).toBeNull();
    // 跨越 Mermaid 图形等无 sourcepos 锚点
    expect(mapSelectionToSource(undefined, '3:1-3:6', SOURCE)).toBeNull();
  });

  it('T-SPOS4 表格/图片边界：超出源文行数判不可映射', () => {
    const offsets = buildLineOffsets(SOURCE);
    const pos = parseSourcePos('99:1-99:2')!;
    expect(sourcePosToOffsets(pos, SOURCE, offsets)).toBeNull();
  });

  it('T-SPOS5 跨块选择映射原文并集', () => {
    const range = mapSelectionToSource('2:1-2:1', '5:1-5:7', SOURCE);
    expect(range).toEqual({ startOffset: 8, endOffset: 32 });
    expect(SOURCE.slice(range!.startOffset, range!.endOffset)).toBe('\nHello **world**\n\n- item');
  });

  it('T-SPOS6 offset 换算精确（含空行与行尾）', () => {
    const offsets = buildLineOffsets('a\nbb\n');
    const range = sourcePosToOffsets({ startLine: 2, startCol: 2, endLine: 2, endCol: 3 }, 'a\nbb\n', offsets);
    expect(range).toEqual({ startOffset: 3, endOffset: 4 });
  });
});
