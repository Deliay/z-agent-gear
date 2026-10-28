import { describe, it, expect } from 'vitest';
import { ansiToHtml } from '../ansi';

describe('ansiToHtml', () => {
  it('should render foreground colors as span styles', () => {
    const html = ansiToHtml('\x1b[31mred text\x1b[0m');
    expect(html).toContain('red text');
    expect(html).toMatch(/color:\s*#/);
  });

  it('should render background colors', () => {
    const html = ansiToHtml('\x1b[44mblue background\x1b[0m');
    expect(html).toContain('blue background');
    expect(html).toMatch(/background-color:\s*#/);
  });

  it('should keep bold as <b>', () => {
    const html = ansiToHtml('\x1b[1mbold text\x1b[22m');
    expect(html).toContain('<b>');
    expect(html).toContain('bold text');
  });

  it('should strip cursor / erase control sequences without garbling text', () => {
    const html = ansiToHtml('\x1b[2K\x1b[1Gprogress 50%\x1b[3A');
    expect(html).toContain('progress 50%');
    expect(html).not.toContain('\x1b');
    expect(html).not.toContain('[2K');
  });

  it('should strip OSC sequences and normalize CRLF', () => {
    const html = ansiToHtml('\x1b]0;window title\x07line1\r\nline2');
    expect(html).not.toContain('window title');
    expect(html).toContain('line1\nline2');
    expect(html).not.toContain('\r');
  });

  it('should strip private mode sequences such as cursor hide and bracketed paste', () => {
    const html = ansiToHtml('\x1b[?25lvisible\x1b[?25h \x1b[?2004hpasted\x1b[?2004l');
    expect(html).toContain('visible');
    expect(html).toContain('pasted');
    expect(html).not.toContain('?25');
    expect(html).not.toContain('?2004');
    expect(html).not.toContain('\x1b');
  });

  it('should strip alternate screen and other trailing-letter CSI sequences', () => {
    const html = ansiToHtml('\x1b[?1049halternate\x1b[?1049l\x1b[2;3rscroll\x1b[1;1Hdone\x1b[1 qcursor-style');
    expect(html).toContain('alternate');
    expect(html).toContain('scroll');
    expect(html).toContain('done');
    expect(html).toContain('cursor-style');
    expect(html).not.toContain('?1049');
    expect(html).not.toContain('2;3r');
    expect(html).not.toContain('1 q');
    expect(html).not.toContain('\x1b');
  });

  it('should strip OSC-8 hyperlink sequences', () => {
    const html = ansiToHtml('\x1b]8;;https://example.com/doc\x1b\\link text\x1b]8;;\x1b\\');
    expect(html).toContain('link text');
    expect(html).not.toContain('https://example.com');
    expect(html).not.toContain('\x1b');
  });

  it('should strip bracketed paste markers 200~/201~', () => {
    const html = ansiToHtml('\x1b[200~pasted\x1b[201~');
    expect(html).toContain('pasted');
    expect(html).not.toContain('~');
    expect(html).not.toContain('\x1b');
  });

  it('should strip CSI sequences with non-letter final bytes @ ` ~', () => {
    expect(ansiToHtml('ICH\x1b[2@ after')).toBe('ICH after');
    expect(ansiToHtml('HPA\x1b[10` after')).not.toContain('`');
    expect(ansiToHtml('Fkey\x1b[15~ after')).not.toContain('~');
  });

  it('should strip private prefix CSI with trailing m (modifyOtherKeys) instead of treating it as SGR', () => {
    const html = ansiToHtml('\x1b[>4;2mtext');
    expect(html).toContain('text');
    expect(html).not.toContain('>4;2m');
    expect(html).not.toContain('\x1b');
  });

  it('should strip DCS / APC / PM string sequences', () => {
    const html = ansiToHtml('\x1bPtmux;abc\x1b\\visible\x1b_Gi=1\x1b\\\x1b^meta\x07end');
    expect(html).toContain('visible');
    expect(html).toContain('end');
    expect(html).not.toContain('tmux');
    expect(html).not.toContain('Gi=1');
    expect(html).not.toContain('meta');
    expect(html).not.toContain('\x1b');
  });

  it('should keep 256-color, truecolor and empty SGR sequences', () => {
    const html = ansiToHtml('\x1b[38;5;200mV1\x1b[0m \x1b[38;2;10;20;30mV2\x1b[0m \x1b[mV3');
    expect(html).toContain('V1');
    expect(html).toContain('V2');
    expect(html).toContain('V3');
    expect(html).toMatch(/color:\s*#/);
  });

  it('should escape HTML special characters (XSS)', () => {
    const html = ansiToHtml('<script>alert("x")</script> & done');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });
});
