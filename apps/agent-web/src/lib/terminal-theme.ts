/**
 * 终端渲染深黑主题 —— 背景/前景与 16 色调色板的单一来源。
 *
 * 终端区域固定深黑配色，与界面浅色/深色模式解耦：组件不得写死 hex，
 * 也不得使用 `dark:` 变体，全部经本模块取值。
 */

export interface TerminalTheme {
  /** 终端区域背景（深黑） */
  background: string;
  /** 默认前景色 */
  foreground: string;
  /** 16 色 ANSI 调色板（参考 VS Code Dark+ / Campbell，深黑底上保证对比度） */
  palette: readonly [
    string, string, string, string,
    string, string, string, string,
    string, string, string, string,
    string, string, string, string,
  ];
}

export const TERMINAL_THEME: TerminalTheme = {
  background: '#050505',
  foreground: '#E8E8E8',
  palette: [
    '#000000',
    '#CD3131',
    '#0DBC79',
    '#E5E510',
    '#2472C8',
    '#BC3FBC',
    '#11A8CD',
    '#E5E5E5',
    '#666666',
    '#F14C4C',
    '#23D18B',
    '#F5F543',
    '#3B8EEA',
    '#D670D6',
    '#29B8DB',
    '#FFFFFF',
  ],
};

/** 单元格颜色来源：默认 / 调色板索引 / 真彩色 */
export type TerminalColor =
  | { kind: 'default' }
  | { kind: 'palette'; index: number }
  | { kind: 'rgb'; r: number; g: number; b: number };

/** 6×6×6 色立方的通道取值（xterm 256 色标准） */
const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;

function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

/**
 * 调色板索引 → CSS 颜色。
 * 0-15 取主题 16 色；16-231 为 6×6×6 色立方；232-255 为灰度渐变。
 */
export function paletteColor(index: number): string {
  if (index >= 0 && index <= 15) {
    return TERMINAL_THEME.palette[index];
  }
  if (index >= 16 && index <= 231) {
    const cubeIndex = index - 16;
    const r = CUBE_STEPS[Math.floor(cubeIndex / 36) % 6];
    const g = CUBE_STEPS[Math.floor(cubeIndex / 6) % 6];
    const b = CUBE_STEPS[cubeIndex % 6];
    return `rgb(${r},${g},${b})`;
  }
  if (index >= 232 && index <= 255) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level},${level},${level})`;
  }
  // 越界索引按默认前景处理，保证永不返回空值
  return TERMINAL_THEME.foreground;
}

/** 颜色描述 → CSS 颜色；`default` 返回 undefined 交由调用方回落 */
function colorToCss(color: TerminalColor): string | undefined {
  if (color.kind === 'palette') return paletteColor(color.index);
  if (color.kind === 'rgb') {
    return `rgb(${clampChannel(color.r)},${clampChannel(color.g)},${clampChannel(color.b)})`;
  }
  return undefined;
}

/**
 * 前景解析：默认 → 主题前景；调色板/RGB → 对应颜色。
 * 加粗 + 调色板 0-7 使用 8-15 亮色变体（与 xterm `drawBoldTextInBrightColors` 默认行为一致）。
 */
export function resolveFg(color: TerminalColor, options?: { bold?: boolean }): string {
  if (color.kind === 'palette' && options?.bold && color.index >= 0 && color.index <= 7) {
    return paletteColor(color.index + 8);
  }
  return colorToCss(color) ?? TERMINAL_THEME.foreground;
}

/** 背景解析：默认 → undefined（不覆盖容器底色）；调色板/RGB → 对应颜色 */
export function resolveBg(color: TerminalColor): string | undefined {
  return colorToCss(color);
}

export interface ResolvedCellColors {
  fg: string;
  bg?: string;
}

/**
 * 单元格最终前景/背景：
 * - 常规：前景回落主题前景，背景缺省不输出（容器底色透出）。
 * - inverse：交换前景/背景；缺省侧回落主题底色/主题前景。
 */
export function resolveCellColors(
  fg: TerminalColor,
  bg: TerminalColor,
  options?: { bold?: boolean; inverse?: boolean },
): ResolvedCellColors {
  const foreground = resolveFg(fg, { bold: options?.bold });
  const background = resolveBg(bg);

  if (!options?.inverse) {
    return { fg: foreground, bg: background };
  }

  return {
    fg: background ?? TERMINAL_THEME.background,
    bg: foreground,
  };
}
