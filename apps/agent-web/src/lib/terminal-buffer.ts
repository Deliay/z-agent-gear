import type { IBuffer, IBufferCell } from '@xterm/headless';
import { logger } from './logger';
import { resolveCellColors, type TerminalColor } from './terminal-theme';

/** 终端解析固定列数：抓取的工具输出没有真实 TTY 宽度，80 为传统终端默认值 */
export const TERMINAL_COLS = 80;
/** 终端解析固定行数（仅用于创建仿真器，最终画面行数由 scrollback 与上限决定） */
export const TERMINAL_ROWS = 24;
/** 回滚缓冲行数：保留足够历史以还原长输出 */
export const TERMINAL_SCROLLBACK = 5000;
/** 单次解析输入字符上限（约 2MB），超限保留尾部 */
export const TERMINAL_MAX_INPUT_CHARS = 2_000_000;
/** 单次渲染行数上限，超限保留最后 N 行（与 lib/diff.ts 口径一致） */
export const TERMINAL_MAX_RENDER_LINES = 2000;

export interface TerminalCellStyle {
  /** CSS 颜色；缺省 = 主题前景（解析结果始终给出具体值） */
  fg?: string;
  /** CSS 颜色；缺省 = 不覆盖容器底色 */
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
  overline?: boolean;
  inverse?: boolean;
  invisible?: boolean;
}

export interface TerminalSpan {
  text: string;
  style: TerminalCellStyle;
}

export interface TerminalLine {
  /** 按同样式合并后的连续片段 */
  spans: TerminalSpan[];
  /** 该 buffer 行是否由上一行折行而来（来自 IBufferLine.isWrapped） */
  wrapped?: boolean;
}

export interface TerminalRenderOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
  maxInputChars?: number;
  maxRenderLines?: number;
}

/**
 * OSC 序列（窗口标题、OSC-8 超链接等），以 BEL 或 ST(ESC \) 结尾。
 * 未终结时只裁到行尾/串尾，避免吞掉后续真实输出。
 */
const OSC_SEQUENCE = /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\|(?=\n)|$)/g; // eslint-disable-line no-control-regex
/**
 * DCS / APC / PM 字符串序列，以 ST(ESC \) 或 BEL 结尾。
 * 未终结时只裁到行尾/串尾，绝不跨行吞掉后续输出。
 */
const STRING_SEQUENCE = /\x1b[P_^][^\x07\x1b\n]*(?:\x07|\x1b\\|(?=\n)|$)/g; // eslint-disable-line no-control-regex
/**
 * CSI：参数字节 0x30-0x3F（含 < = > ?）、中间字节 0x20-0x2F、终结字节 0x40-0x7E。
 * 终结字节缺失（流式/截断）时只裁到行尾/串尾，避免参数泄漏为正文。
 */
const CSI_SEQUENCE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*(?:[\x40-\x7e]|(?=\n)|$)/g; // eslint-disable-line no-control-regex
/** 字符集切换与键盘模式切换 */
const MISC_ESCAPE = /\x1b[()#][A-Za-z0-9]|\x1b[=>]/g; // eslint-disable-line no-control-regex
/** 其余两字节转义序列 */
const GENERIC_ESCAPE = /\x1b[\x20-\x2f]*[\x30-\x7e]/g; // eslint-disable-line no-control-regex
/** 8-bit C1 CSI（0x9B 引导） */
const C1_CSI = /\x9b[\x30-\x3f]*[\x20-\x2f]*(?:[\x40-\x7e]|(?=\n)|$)/g;

/** `\r` 覆盖语义：同一行内只保留最后一次回车之后的内容（进度条类输出不堆叠） */
function normalizeCarriageReturns(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const lastCarriageReturn = line.lastIndexOf('\r');
      return lastCarriageReturn === -1 ? line : line.slice(lastCarriageReturn + 1);
    })
    .join('\n');
}

/**
 * 解析失败/模块加载失败时的纯文本降级：剥离全部控制序列，保留正文与换行/制表符，
 * 并按 `\r` 近似覆写语义收敛为最终文本。
 */
export function stripTerminalSequences(raw: string): string {
  return normalizeCarriageReturns(raw ?? '')
    .replace(OSC_SEQUENCE, '')
    .replace(STRING_SEQUENCE, '')
    .replace(C1_CSI, '')
    .replace(CSI_SEQUENCE, '')
    .replace(MISC_ESCAPE, '')
    .replace(GENERIC_ESCAPE, '')
    .replace(/\x1b/g, '') // eslint-disable-line no-control-regex
    // 残留 C1 控制符（含孤立 ST 0x9C）与 C0 控制符（保留 \t \n）
    .replace(/[\u0080-\u009f]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''); // eslint-disable-line no-control-regex
}

function readCellColor(cell: IBufferCell, kind: 'fg' | 'bg'): TerminalColor {
  const isDefault = kind === 'fg' ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return { kind: 'default' };

  const isRgb = kind === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
  const value = kind === 'fg' ? cell.getFgColor() : cell.getBgColor();
  if (isRgb) {
    return {
      kind: 'rgb',
      r: (value >> 16) & 0xff,
      g: (value >> 8) & 0xff,
      b: value & 0xff,
    };
  }
  return { kind: 'palette', index: value };
}

function styleKey(style: TerminalCellStyle): string {
  return [
    style.fg ?? '',
    style.bg ?? '',
    style.bold ? '1' : '0',
    style.italic ? '1' : '0',
    style.underline ? '1' : '0',
    style.dim ? '1' : '0',
    style.strikethrough ? '1' : '0',
    style.overline ? '1' : '0',
    style.inverse ? '1' : '0',
    style.invisible ? '1' : '0',
  ].join('|');
}

interface CellSnapshot {
  text: string;
  style: TerminalCellStyle;
}

function readLine(line: NonNullable<ReturnType<IBuffer['getLine']>>, nullCell: IBufferCell): TerminalLine {
  const cells: CellSnapshot[] = [];

  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x, nullCell);
    if (!cell) continue;
    const width = cell.getWidth();
    // 宽字符的续格（width=0）跳过，避免重复输出
    if (width === 0) continue;

    const invisible = Boolean(cell.isInvisible());
    const rawChars = cell.getChars() || ' ';
    const text = invisible ? ' '.repeat(width) : rawChars;
    const bold = Boolean(cell.isBold());
    const inverse = Boolean(cell.isInverse());
    const colors = resolveCellColors(readCellColor(cell, 'fg'), readCellColor(cell, 'bg'), {
      bold,
      inverse,
    });

    cells.push({
      text,
      style: {
        fg: colors.fg,
        bg: colors.bg,
        bold: bold || undefined,
        italic: Boolean(cell.isItalic()) || undefined,
        underline: Boolean(cell.isUnderline()) || undefined,
        dim: Boolean(cell.isDim()) || undefined,
        strikethrough: Boolean(cell.isStrikethrough()) || undefined,
        overline: Boolean(cell.isOverline()) || undefined,
        inverse: inverse || undefined,
        invisible: invisible || undefined,
      },
    });
  }

  // 剔除行尾纯空白单元格（有背景色的尾格视为可见内容）
  let end = cells.length;
  while (end > 0) {
    const cell = cells[end - 1];
    if (cell.text.trim() === '' && !cell.style.bg) {
      end -= 1;
    } else {
      break;
    }
  }

  const spans: TerminalSpan[] = [];
  let lastKey = '';
  for (let index = 0; index < end; index += 1) {
    const cell = cells[index];
    const key = styleKey(cell.style);
    if (spans.length > 0 && key === lastKey) {
      spans[spans.length - 1].text += cell.text;
    } else {
      spans.push({ text: cell.text, style: cell.style });
      lastKey = key;
    }
  }

  return { spans, wrapped: line.isWrapped || undefined };
}

function readBuffer(buffer: IBuffer): TerminalLine[] {
  const nullCell = buffer.getNullCell();
  const lines: TerminalLine[] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    if (!line) continue;
    lines.push(readLine(line, nullCell));
  }
  return lines;
}

function isEmptyLine(line: TerminalLine): boolean {
  return line.spans.length === 0;
}

function trimTrailingEmptyLines(lines: TerminalLine[]): TerminalLine[] {
  let end = lines.length;
  while (end > 0 && isEmptyLine(lines[end - 1])) {
    end -= 1;
  }
  return lines.slice(0, end);
}

function noticeLine(text: string): TerminalLine {
  return { spans: [{ text, style: { dim: true, italic: true } }] };
}

function fallbackLines(text: string): TerminalLine[] {
  return stripTerminalSequences(text)
    .split('\n')
    .map((line) => (line === '' ? { spans: [] } : { spans: [{ text: line, style: {} }] }));
}

function finalizeLines(
  parsed: TerminalLine[],
  truncationNotice: string | null,
  maxRenderLines: number,
): TerminalLine[] {
  const notices: TerminalLine[] = [];
  if (truncationNotice) notices.push(noticeLine(truncationNotice));

  let body = trimTrailingEmptyLines(parsed);
  if (body.length > maxRenderLines) {
    notices.push(noticeLine(`…（共 ${body.length} 行，仅显示最后 ${maxRenderLines} 行）`));
    body = body.slice(-maxRenderLines);
  }

  return [...notices, ...body];
}

/**
 * 解析原始终端输出为最终画面行：以 `@xterm/headless` 完整终端仿真承载
 * 光标移动/擦除/清屏/回车覆写等语义，读取 buffer 活动区得到收敛后的画面。
 *
 * 永不 reject：模块加载、构造、写入或读取失败时降级为纯文本行。
 */
export async function renderTerminalOutput(
  raw: string,
  options?: TerminalRenderOptions,
): Promise<TerminalLine[]> {
  if (!raw || !raw.trim()) return [];

  const maxInputChars = options?.maxInputChars ?? TERMINAL_MAX_INPUT_CHARS;
  const maxRenderLines = options?.maxRenderLines ?? TERMINAL_MAX_RENDER_LINES;

  let text = raw;
  let truncationNotice: string | null = null;
  if (text.length > maxInputChars) {
    const truncated = text.length - maxInputChars;
    truncationNotice = `…（输出过长，已截断前 ${truncated} 字符）`;
    const tail = text.slice(-maxInputChars);
    // 避免从代理对中间切开产生孤立代理字符（乱码）
    text = /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail;
  }

  let terminal: import('@xterm/headless').Terminal | undefined;
  try {
    const { Terminal } = await import('@xterm/headless');
    terminal = new Terminal({
      cols: options?.cols ?? TERMINAL_COLS,
      rows: options?.rows ?? TERMINAL_ROWS,
      scrollback: options?.scrollback ?? TERMINAL_SCROLLBACK,
      convertEol: true,
      allowProposedApi: true,
      logLevel: 'off',
    });

    await new Promise<void>((resolve) => {
      terminal?.write(text, resolve);
    });

    const parsed = readBuffer(terminal.buffer.active);
    return finalizeLines(parsed, truncationNotice, maxRenderLines);
  } catch (err) {
    logger.warn({ err }, 'terminal parse failed');
    return finalizeLines(fallbackLines(text), truncationNotice, maxRenderLines);
  } finally {
    terminal?.dispose();
  }
}
