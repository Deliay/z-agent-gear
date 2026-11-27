import { describe, expect, it } from 'vitest';

const adminWebSources = import.meta.glob(
  ['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../**/*.d.ts', '!../**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const MICRO_FONT_REGEX = /\btext-\[(?:[1-9]|1[01])px\]/g;
const HARDCODED_HEX_REGEX = /#[0-9a-fA-F]{3,8}\b/g;

describe('UI/UX Design Standards Guard (docs/engineering/ui-ux-standards.md)', () => {
  it('T-UIUX-FONT2: apps/admin-web/src 下禁止使用小于 12px 的微字号（text-[9px]/text-[10px]/text-[11px]）', () => {
    const entries = Object.entries(adminWebSources);
    expect(entries.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const [filePath, content] of entries) {
      const matches = content.match(MICRO_FONT_REGEX);
      if (matches) {
        violations.push(`${filePath}: ${matches.join(', ')}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('T-UIUX-COLOR1: 源码禁止硬编码 hex 色值，颜色一律取语义 Token', () => {
    const violations: string[] = [];
    for (const [filePath, content] of Object.entries(adminWebSources)) {
      const matches = content.match(HARDCODED_HEX_REGEX);
      if (matches) {
        violations.push(`${filePath}: ${matches.join(', ')}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('T-UIUX-TABLE1: 列表页表头统一引用 table-styles 常量口径', () => {
    const tableFiles = Object.entries(adminWebSources).filter(([, content]) => content.includes('<th'));

    expect(tableFiles.length).toBeGreaterThan(0);
    const violations = tableFiles
      .filter(
        ([, content]) =>
          !content.includes("from '@/lib/table-styles'") ||
          (!content.includes('TABLE_HEAD_CLASS') && !content.includes('TABLE_HEAD_CELL_CLASS')),
      )
      .map(([filePath]) => filePath);

    expect(violations).toEqual([]);
  });
});
