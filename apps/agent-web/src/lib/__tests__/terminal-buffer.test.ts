import { describe, it, expect } from 'vitest';
import {
  renderTerminalOutput,
  stripTerminalSequences,
  type TerminalLine,
} from '../terminal-buffer';
import { TERMINAL_THEME } from '../terminal-theme';

function lineText(line: TerminalLine): string {
  return line.spans.map((span) => span.text).join('');
}

function textOf(lines: TerminalLine[]): string {
  return lines.map(lineText).join('\n');
}

function findSpan(lines: TerminalLine[], text: string) {
  for (const line of lines) {
    for (const span of line.spans) {
      if (span.text.includes(text)) return span;
    }
  }
  return undefined;
}

describe('terminal-buffer (T-TB)', () => {
  it('T-TB1 should render SGR colors with the theme palette', async () => {
    const lines = await renderTerminalOutput('\u001b[31mred\u001b[0m ok');
    const red = findSpan(lines, 'red');
    expect(red?.style.fg).toBe(TERMINAL_THEME.palette[1]);
    expect(textOf(lines)).toContain('red');
    expect(textOf(lines)).toContain('ok');
  });

  it('T-TB2 should map background and text attributes', async () => {
    const lines = await renderTerminalOutput(
      '\u001b[44mBG\u001b[0m \u001b[1mBOLD\u001b[0m \u001b[3mITALIC\u001b[0m \u001b[4mUNDER\u001b[0m \u001b[2mDIM\u001b[0m',
    );

    expect(findSpan(lines, 'BG')?.style.bg).toBe(TERMINAL_THEME.palette[4]);
    expect(findSpan(lines, 'BOLD')?.style.bold).toBe(true);
    expect(findSpan(lines, 'ITALIC')?.style.italic).toBe(true);
    expect(findSpan(lines, 'UNDER')?.style.underline).toBe(true);
    expect(findSpan(lines, 'DIM')?.style.dim).toBe(true);
  });

  it('T-TB2b should map inverse, invisible, strikethrough and overline', async () => {
    const lines = await renderTerminalOutput(
      '\u001b[7mINV\u001b[0m \u001b[8mHIDDEN\u001b[0mOK \u001b[9mSTRIKE\u001b[0m \u001b[53mOVER\u001b[0m',
    );

    const inverse = findSpan(lines, 'INV');
    expect(inverse?.style.inverse).toBe(true);
    expect(inverse?.style.fg).toBe(TERMINAL_THEME.background);
    expect(inverse?.style.bg).toBe(TERMINAL_THEME.foreground);

    const hidden = lines[0].spans.find((span) => span.style.invisible);
    expect(hidden?.text).toBe('      ');

    expect(findSpan(lines, 'STRIKE')?.style.strikethrough).toBe(true);
    expect(findSpan(lines, 'OVER')?.style.overline).toBe(true);
  });

  it('T-TB2c should keep trailing cells that carry a background color', async () => {
    const lines = await renderTerminalOutput('\u001b[44m  \u001b[0m');

    expect(lineText(lines[0])).toBe('  ');
    expect(lines[0].spans[0].style.bg).toBe(TERMINAL_THEME.palette[4]);
  });

  it('T-TB3 should render 256-color and truecolor', async () => {
    const lines = await renderTerminalOutput(
      '\u001b[38;5;200mP256\u001b[0m \u001b[38;2;10;20;30mRGB\u001b[0m',
    );

    expect(findSpan(lines, 'P256')?.style.fg).toBe('rgb(255,0,215)');
    expect(findSpan(lines, 'RGB')?.style.fg).toBe('rgb(10,20,30)');
  });

  it('T-TB4 should converge carriage-return progress output', async () => {
    const lines = await renderTerminalOutput('progress 10%\rprogress 55%\rprogress 100%');

    expect(lines).toHaveLength(1);
    expect(lineText(lines[0])).toBe('progress 100%');
  });

  it('T-TB5 should apply cursor-up and line-erase redraws', async () => {
    const lines = await renderTerminalOutput(
      'header\nprogress 10%\nfooter\u001b[1A\r\u001b[2Kprogress 100%',
    );

    expect(lines.map(lineText)).toEqual(['header', 'progress 100%', 'footer']);
  });

  it('T-TB6 should clear the screen with ED', async () => {
    const lines = await renderTerminalOutput('old stuff\u001b[2J\u001b[Hfresh');

    expect(textOf(lines)).toContain('fresh');
    expect(textOf(lines)).not.toContain('old stuff');
  });

  it('T-TB7 should restore the main screen after leaving the alternate screen', async () => {
    const lines = await renderTerminalOutput('main\u001b[?1049halt screen\u001b[?1049lback');

    const text = textOf(lines);
    expect(text).toContain('main');
    expect(text).toContain('back');
    expect(text).not.toContain('alt screen');
  });

  it('T-TB8 should wrap long lines at the configured columns', async () => {
    const longLine = 'x'.repeat(200);
    const lines = await renderTerminalOutput(longLine, { cols: 80 });

    expect(lines).toHaveLength(3);
    expect(lineText(lines[0])).toHaveLength(80);
    expect(lineText(lines[1])).toHaveLength(80);
    expect(lineText(lines[2])).toHaveLength(40);
    expect(lines[0].wrapped).toBeUndefined();
    expect(lines[1].wrapped).toBe(true);
    expect(lines[2].wrapped).toBe(true);
  });

  it('T-TB9 should return no lines for empty or whitespace-only input', async () => {
    expect(await renderTerminalOutput('')).toEqual([]);
    expect(await renderTerminalOutput('   \n  ')).toEqual([]);
  });

  it('T-TB10 should start every line at column zero for bare newlines', async () => {
    const lines = await renderTerminalOutput('alpha\nbeta');

    expect(lines.map(lineText)).toEqual(['alpha', 'beta']);
  });

  it('T-TB11 should tolerate a truncated escape sequence', async () => {
    const lines = await renderTerminalOutput('abc\u001b[31');

    expect(textOf(lines)).toBe('abc');
  });

  it('T-TB12 should strip OSC/DCS/APC/PM/C1 sequences and keep the text', async () => {
    const lines = await renderTerminalOutput(
      '\u001b]0;title\u0007A'
      + '\u001b]8;;https://example.com\u001b\\B\u001b]8;;\u001b\\'
      + '\u001bP1;2;3q\u001b\\C'
      + '\u001b_apc\u001b\\D'
      + '\u001b^pm\u001b\\E'
      + '\u009b31mF'
      + '\u001b[?25lG',
    );

    const text = textOf(lines);
    expect(text).toContain('ABCDEFG');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('title');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('apc');
    expect(text).not.toContain('?25');
  });

  it('T-TB12b should consume extended CSI/private sequences without leaking', async () => {
    const lines = await renderTerminalOutput(
      'ICH\u001b[2@ after\n'
      + 'HPA\u001b[10` after\n'
      + 'Fkey\u001b[15~ after\n'
      + 'mode\u001b[>4;2mtext',
    );

    const text = textOf(lines);
    expect(text).toContain('after');
    expect(text).toContain('text');
    expect(text).not.toContain('`');
    expect(text).not.toContain('~');
    expect(text).not.toContain('>4;2m');
  });

  it('T-TB12c should tolerate unterminated OSC/DCS/CSI at end of input', async () => {
    expect(textOf(await renderTerminalOutput('keep \u001bPtmux;unterminated'))).toContain('keep');
    expect(textOf(await renderTerminalOutput('before \u001b]0;window title'))).toContain('before');
    expect(textOf(await renderTerminalOutput('before \u001b[38;5;2'))).toContain('before');
  });

  it('T-TB12d should normalize T.416 colon SGR truecolor', async () => {
    const lines = await renderTerminalOutput('\u001b[38:2::10:20:30mtruecolor');

    expect(findSpan(lines, 'truecolor')?.style.fg).toBe('rgb(10,20,30)');
  });

  it('T-TB13 should not duplicate or drop wide characters', async () => {
    const lines = await renderTerminalOutput('中文😀ok');

    expect(textOf(lines)).toBe('中文😀ok');
  });

  it('T-TB14 should keep HTML special characters as plain text', async () => {
    const input = '<img src=x onerror=alert(1)>';
    const lines = await renderTerminalOutput(input);

    expect(textOf(lines)).toBe(input);
  });

  it('T-TB15 should keep the tail and prepend a notice when input is too large', async () => {
    const lines = await renderTerminalOutput('0123456789ABCDEFGHIJ', { maxInputChars: 10 });

    expect(lineText(lines[0])).toContain('已截断前 10 字符');
    expect(lineText(lines[1])).toBe('ABCDEFGHIJ');
  });

  it('T-TB15b should not leave a lone surrogate at the truncation boundary', async () => {
    const lines = await renderTerminalOutput('A😀BC', { maxInputChars: 3 });

    expect(lineText(lines[0])).toContain('已截断前 2 字符');
    expect(lineText(lines[1])).toBe('BC');
  });

  it('T-TB16 should keep the last N lines and prepend a notice when too many lines', async () => {
    const lines = await renderTerminalOutput('l1\nl2\nl3\nl4\nl5', { maxRenderLines: 3 });

    expect(lineText(lines[0])).toContain('共 5 行');
    expect(lines.slice(1).map(lineText)).toEqual(['l3', 'l4', 'l5']);
  });

  it('T-TB17 should expand tabs at terminal tab stops', async () => {
    const lines = await renderTerminalOutput('a\tb');

    expect(lineText(lines[0])).toBe(`a${' '.repeat(7)}b`);
  });

  it('stripTerminalSequences should strip control sequences and apply carriage returns', () => {
    expect(stripTerminalSequences('\u001b[31mred\u001b[0m\rfinal')).toBe('final');
    expect(stripTerminalSequences('a\u001b]0;t\u0007b')).toBe('ab');
    expect(stripTerminalSequences('keep\tthis')).toBe('keep\tthis');
  });
});
