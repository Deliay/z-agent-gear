import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TerminalOutput from '../TerminalOutput';

describe('TerminalOutput (T-TO)', () => {
  it('T-TO1 should render ANSI colors as span styles', () => {
    render(<TerminalOutput output={'\u001b[31merror\u001b[0m ok'} />);

    const terminal = screen.getByTestId('terminal-output');
    expect(terminal.textContent).toContain('error');
    expect(terminal.querySelector('span[style*="color"]')).toBeTruthy();
  });

  it('T-TO2 should preserve bold', () => {
    render(<TerminalOutput output={'\u001b[1mbold\u001b[0m'} />);

    expect(screen.getByTestId('terminal-output').innerHTML).toContain('<b>');
  });

  it('T-TO3 should not leak non-display control sequences', () => {
    render(<TerminalOutput output={'\u001b[2K\u001b[?25lclean text\u001b[?25h'} />);

    const text = screen.getByTestId('terminal-output').textContent ?? '';
    expect(text).toContain('clean text');
    expect(text).not.toContain('?25');
    expect(text).not.toContain('\u001b');
  });

  it('T-TO4 should escape HTML from terminal output (XSS)', () => {
    render(<TerminalOutput output={'<img src=x onerror=alert(1)>'} />);

    const html = screen.getByTestId('terminal-output').innerHTML;
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('T-TO5 should keep empty lines and apply maxHeight', () => {
    render(<TerminalOutput output={'line1\n\nline3'} maxHeight="12rem" />);

    const terminal = screen.getByTestId('terminal-output');
    expect(terminal.textContent).toContain('line1');
    expect(terminal.textContent).toContain('line3');
    expect(terminal.style.maxHeight).toBe('12rem');
    expect(terminal.className).toContain('whitespace-pre-wrap');
  });

  it('T-TO6 should render an empty output without crashing', () => {
    render(<TerminalOutput output="" />);

    expect(screen.getByTestId('terminal-output').textContent).toBe('');
  });
});
