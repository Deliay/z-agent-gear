import { describe, expect, it } from 'vitest';

const agentWebSources = import.meta.glob(
  ['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../**/*.d.ts', '!../**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const MICRO_FONT_REGEX = /\btext-\[(?:[1-9]|1[01])px\]/g;

describe('UI/UX Design Standards Guard (docs/engineering/ui-ux-standards.md)', () => {
  it('T-UIUX-FONT1: apps/agent-web/src 下禁止使用小于 12px 的微字号（text-[9px]/text-[10px]/text-[11px]）', () => {
    const entries = Object.entries(agentWebSources);
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
});
