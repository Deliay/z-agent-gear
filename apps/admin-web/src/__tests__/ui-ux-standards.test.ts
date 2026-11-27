import { describe, expect, it } from 'vitest';

const adminWebSources = import.meta.glob(
  ['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../**/*.d.ts', '!../**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const MICRO_FONT_REGEX = /\btext-\[(?:[1-9]|1[01])px\]/g;
const HARDCODED_HEX_REGEX = /#[0-9a-fA-F]{3,8}\b/g;
/** 任意值形式的颜色（`bg-[oklch(...)]` / `text-[rgb(...)]` 等）一律视为散落色值。 */
const ARBITRARY_COLOR_REGEX =
  /\b[a-z-]+-\[[^\]]*(?:oklch|rgba?|hsla?)\([^\]]*\]/g;
/** 裸调色板黑白（`bg-black/10` / `text-white` / `border-white/10`）不走语义 Token。 */
const RAW_MONOCHROME_REGEX =
  /\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|decoration|shadow|placeholder|accent|caret)-(?:white|black)(?:\/\d+)?\b/g;
/** 旧表格单元格内边距组合：迁移不彻底会与表头 `py-2.5 px-3` 错位。 */
const LEGACY_TABLE_CELL_REGEX =
  /<(?:td|th)\b[^\n>]*\b(?:px-4 py-3|py-3 px-4|py-2 pr-3|py-2 px-2|py-2 px-3|py-3 px-3)\b[^\n>]*>/g;

function collectMatches(
  entries: Array<[string, string]>,
  regex: RegExp,
): string[] {
  const violations: string[] = [];
  for (const [filePath, content] of entries) {
    const matches = content.match(regex);
    if (matches) {
      violations.push(`${filePath}: ${matches.join(', ')}`);
    }
  }
  return violations;
}

describe('UI/UX Design Standards Guard (docs/engineering/ui-ux-standards.md)', () => {
  it('T-UIUX-FONT2: apps/admin-web/src 下禁止使用小于 12px 的微字号（text-[9px]/text-[10px]/text-[11px]）', () => {
    const entries = Object.entries(adminWebSources);
    expect(entries.length).toBeGreaterThan(0);

    expect(collectMatches(entries, MICRO_FONT_REGEX)).toEqual([]);
  });

  it('T-UIUX-COLOR1: 源码禁止硬编码色值（hex / oklch / rgb / hsl 任意值 / 裸黑白），颜色一律取语义 Token', () => {
    const entries = Object.entries(adminWebSources);

    expect(collectMatches(entries, HARDCODED_HEX_REGEX)).toEqual([]);
    expect(collectMatches(entries, ARBITRARY_COLOR_REGEX)).toEqual([]);
    expect(collectMatches(entries, RAW_MONOCHROME_REGEX)).toEqual([]);
  });

  it('T-UIUX-TABLE1: 列表页表头与单元格成对引用 table-styles 常量口径', () => {
    const tableFiles = Object.entries(adminWebSources).filter(([, content]) => content.includes('<th'));

    expect(tableFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const [filePath, content] of tableFiles) {
      // 1. 表头必须来自 table-styles 常量
      if (
        !content.includes("from '@/lib/table-styles'") ||
        (!content.includes('TABLE_HEAD_CLASS') && !content.includes('TABLE_HEAD_CELL_CLASS'))
      ) {
        violations.push(`${filePath}: 未引用 table-styles 表头常量`);
        continue;
      }

      // 2. 表头行样式必须挂在 <tr>，避免 thead/tr 两种写法混用
      const theadClass = content.match(/<thead\s+className=/g);
      if (theadClass) {
        violations.push(`${filePath}: 表头样式应挂在 <tr>（发现 <thead className>）`);
      }

      // 3. 禁止旧的内边距组合（同一表格只迁移一半会破坏列对齐）
      const legacy = content.match(LEGACY_TABLE_CELL_REGEX);
      if (legacy) {
        violations.push(`${filePath}: 旧单元格间距 ${legacy.join(', ')}`);
      }

      // 3. 操作列单元格右对齐时，表头必须同样右对齐
      if (
        content.includes('TABLE_ACTION_CELL_CLASS') &&
        !content.includes('TABLE_HEAD_CELL_ACTION_CLASS') &&
        !content.includes('TABLE_HEAD_CELL_NUMERIC_CLASS')
      ) {
        violations.push(`${filePath}: 操作列单元格右对齐但表头未使用右对齐常量`);
      }

      // 4. 数字列单元格右对齐时，表头必须同样右对齐
      if (
        content.includes('TABLE_CELL_NUMERIC_CLASS') &&
        !content.includes('TABLE_HEAD_CELL_NUMERIC_CLASS') &&
        !content.includes('TABLE_HEAD_CELL_ACTION_CLASS')
      ) {
        violations.push(`${filePath}: 数字列单元格右对齐但表头未使用右对齐常量`);
      }
    }

    expect(violations).toEqual([]);
  });
});
