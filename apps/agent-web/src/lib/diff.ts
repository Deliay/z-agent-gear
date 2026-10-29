import { diffArrays } from 'diff';

export interface DiffLine {
  type: 'same' | 'added' | 'removed';
  text: string;
  /** removed/same 行携带（旧文件行号） */
  oldLineNumber?: number;
  /** added/same 行携带（新文件行号） */
  newLineNumber?: number;
  /** 截断提示行（非真实内容） */
  truncated?: boolean;
}

/** 单次展示的最大差异行数，超出截断并给出提示 */
export const MAX_DIFF_LINES = 2000;
/** 进入 diff 计算的输入行数上限，避免超大文件全量计算阻塞 UI（M-6） */
const MAX_DIFF_INPUT_LINES = MAX_DIFF_LINES * 4;

export const DIFF_TRUNCATED_NOTICE = `差异过长，仅展示前 ${MAX_DIFF_LINES} 行`;

/** 换行归一：CRLF / CR 统一为 LF，避免 Windows 文件全量重写噪声（R-7） */
function normalizeNewlines(value: string): string {
  return (value ?? '').replace(/\r\n?/g, '\n');
}

/**
 * 按纯行文本切分：尾换行不代表额外空行，避免「尾行无换行」被 diff 误报（R-6）。
 * 空字符串表示零行（与 diffLines 口径一致）。
 */
function splitLines(value: string): string[] {
  const normalized = normalizeNewlines(value);
  if (!normalized) return [];
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * 行级差异计算：先归一化换行，再按纯行文本做 diffArrays，输出带新旧行号的行序列。
 * 以「行内容」为比较粒度，尾换行差异视为同一行（与主流 diff 展示口径一致）。
 * 不处理「新建文件」语义（oldText 为 null 时由调用方传空串）。
 */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  let oldLines = splitLines(oldText);
  let newLines = splitLines(newText);
  if (oldLines.length > MAX_DIFF_INPUT_LINES) {
    oldLines = oldLines.slice(0, MAX_DIFF_INPUT_LINES);
  }
  if (newLines.length > MAX_DIFF_INPUT_LINES) {
    newLines = newLines.slice(0, MAX_DIFF_INPUT_LINES);
  }
  const parts = diffArrays(oldLines, newLines);
  const result: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const part of parts) {
    for (const text of part.value) {
      if (part.added) {
        result.push({ type: 'added', text, newLineNumber: newLine });
        newLine += 1;
      } else if (part.removed) {
        result.push({ type: 'removed', text, oldLineNumber: oldLine });
        oldLine += 1;
      } else {
        result.push({ type: 'same', text, oldLineNumber: oldLine, newLineNumber: newLine });
        oldLine += 1;
        newLine += 1;
      }
    }
  }

  if (result.length > MAX_DIFF_LINES) {
    const truncated = result.slice(0, MAX_DIFF_LINES);
    truncated.push({ type: 'same', text: DIFF_TRUNCATED_NOTICE, truncated: true });
    return truncated;
  }

  return result;
}
