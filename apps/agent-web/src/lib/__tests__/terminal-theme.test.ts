import { describe, it, expect } from 'vitest';
import {
  TERMINAL_THEME,
  paletteColor,
  resolveBg,
  resolveCellColors,
  resolveFg,
} from '../terminal-theme';

describe('terminal-theme (T-TT)', () => {
  it('T-TT1 should map palette 0-15 to the theme palette', () => {
    for (let index = 0; index < 16; index += 1) {
      expect(paletteColor(index)).toBe(TERMINAL_THEME.palette[index]);
    }
  });

  it('T-TT2 should map 256-color cube and grayscale', () => {
    expect(paletteColor(16)).toBe('rgb(0,0,0)');
    expect(paletteColor(21)).toBe('rgb(0,0,255)');
    expect(paletteColor(231)).toBe('rgb(255,255,255)');
    expect(paletteColor(232)).toBe('rgb(8,8,8)');
    expect(paletteColor(255)).toBe('rgb(238,238,238)');
  });

  it('T-TT2b should fall back to the theme foreground for out-of-range palette indexes', () => {
    expect(paletteColor(-1)).toBe(TERMINAL_THEME.foreground);
    expect(paletteColor(256)).toBe(TERMINAL_THEME.foreground);
  });

  it('T-TT3 should resolve default foreground and leave default background unset', () => {
    expect(resolveFg({ kind: 'default' })).toBe(TERMINAL_THEME.foreground);
    expect(resolveBg({ kind: 'default' })).toBeUndefined();
    expect(resolveCellColors({ kind: 'default' }, { kind: 'default' })).toEqual({
      fg: TERMINAL_THEME.foreground,
      bg: undefined,
    });
  });

  it('T-TT4 should use bright palette variants for bold palette 0-7', () => {
    for (let index = 0; index < 8; index += 1) {
      expect(resolveFg({ kind: 'palette', index }, { bold: true }))
        .toBe(TERMINAL_THEME.palette[index + 8]);
    }
    expect(resolveFg({ kind: 'palette', index: 9 }, { bold: true }))
      .toBe(TERMINAL_THEME.palette[9]);
  });

  it('T-TT5 should resolve RGB colors exactly', () => {
    expect(resolveFg({ kind: 'rgb', r: 10, g: 20, b: 30 })).toBe('rgb(10,20,30)');
    expect(resolveBg({ kind: 'rgb', r: 10, g: 20, b: 30 })).toBe('rgb(10,20,30)');
    expect(resolveFg({ kind: 'rgb', r: Number.NaN, g: -5, b: 300 })).toBe('rgb(0,0,255)');
  });

  it('T-TT6 should swap colors for inverse and fall back to theme colors', () => {
    expect(resolveCellColors(
      { kind: 'palette', index: 1 },
      { kind: 'palette', index: 4 },
      { inverse: true },
    )).toEqual({ fg: TERMINAL_THEME.palette[4], bg: TERMINAL_THEME.palette[1] });

    expect(resolveCellColors(
      { kind: 'default' },
      { kind: 'default' },
      { inverse: true },
    )).toEqual({ fg: TERMINAL_THEME.background, bg: TERMINAL_THEME.foreground });
  });
});
