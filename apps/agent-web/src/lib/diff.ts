import { diffLines } from 'diff';

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

export const DIFF_TRUNCATED_NOTICE = `差异过长，仅展示前 ${MAX_DIFF_LINES} 行`;

function splitLines(value: string): string[] {
  const lines = value.split('\n');
  // diffLines 的块以 \n 结尾时最后会多出一个空串，不代表真实空行
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * 行级差异计算：基于 jsdiff diffLines，输出带新旧行号的行序列。
 * 不处理「新建文件」语义（oldText 为 null 时由调用方传空串）。
 */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
  const parts = diffLines(oldText ?? '', newText ?? '');
  const result: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const part of parts) {
    const lines = splitLines(part.value);
    for (const text of lines) {
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
