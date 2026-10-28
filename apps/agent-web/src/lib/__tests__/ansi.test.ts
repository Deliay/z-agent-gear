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

  it('should escape HTML special characters (XSS)', () => {
    const html = ansiToHtml('<script>alert("x")</script> & done');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });
});
