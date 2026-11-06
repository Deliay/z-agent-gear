/**
 * Markdown sourcepos ↔ 源文 offset 映射（提案 §5.2 实现点 3）。
 *
 * `data-sourcepos="startLine:startCol-endLine:endCol"`（hast `position`）
 * 经行偏移表换算为源文 offset 区间；无法可靠映射（无 sourcepos / 跨越
 * 代码块、表格、图片等）时判定「不可映射」。
 */

export interface SourcePos {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/** 按行累加的 offset 表：lineOffsets[i] = 第 i+1 行（1-based）起始 offset */
export function buildLineOffsets(source: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/** 解析 `startLine:startCol-endLine:endCol`；非法返回 null */
export function parseSourcePos(raw: string | null | undefined): SourcePos | null {
  if (!raw) return null;
  const match = /^(\d+):(\d+)-(\d+):(\d+)$/.exec(raw.trim());
  if (!match) return null;
  const [, sl, sc, el, ec] = match.map(Number) as unknown as [number, number, number, number, number];
  if (sl < 1 || el < sl) return null;
  return { startLine: sl, startCol: sc, endLine: el, endCol: ec };
}

/**
 * sourcepos → 源文 offset 区间。列号按 1-based、字符级。
 * 行号超出源文行数视为不可映射（返回 null）。
 */
export function sourcePosToOffsets(
  pos: SourcePos,
  source: string,
  lineOffsets: number[] = buildLineOffsets(source),
): { startOffset: number; endOffset: number } | null {
  const lineCount = lineOffsets.length;
  if (pos.startLine > lineCount || pos.endLine > lineCount) return null;
  const startOffset = lineOffsets[pos.startLine - 1] + (pos.startCol - 1);
  const endOffset = lineOffsets[pos.endLine - 1] + (pos.endCol - 1);
  if (startOffset < 0 || endOffset > source.length || endOffset < startOffset) return null;
  return { startOffset, endOffset };
}

/** 区间并集：跨块选择合并为覆盖两块的最小闭区间 */
export function unionOffsets(
  a: { startOffset: number; endOffset: number },
  b: { startOffset: number; endOffset: number },
): { startOffset: number; endOffset: number } {
  return {
    startOffset: Math.min(a.startOffset, b.startOffset),
    endOffset: Math.max(a.endOffset, b.endOffset),
  };
}

/**
 * 判定选择是否可映射到原文：两个锚点均能解析出 sourcepos 且换算成功。
 * 代码块/表格/图片等无 sourcepos 的节点、跨越 Mermaid 图形的选择返回 null。
 */
export function mapSelectionToSource(
  anchorRaw: string | null | undefined,
  focusRaw: string | null | undefined,
  source: string,
  lineOffsets: number[] = buildLineOffsets(source),
): { startOffset: number; endOffset: number } | null {
  const anchorPos = parseSourcePos(anchorRaw);
  const focusPos = parseSourcePos(focusRaw);
  if (!anchorPos || !focusPos) return null;
  const anchorOffsets = sourcePosToOffsets(anchorPos, source, lineOffsets);
  const focusOffsets = sourcePosToOffsets(focusPos, source, lineOffsets);
  if (!anchorOffsets || !focusOffsets) return null;
  return unionOffsets(anchorOffsets, focusOffsets);
}
