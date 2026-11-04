import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import TerminalOutput from '../TerminalOutput';

describe('TerminalOutput (T-TO)', () => {
  it('T-TO1 should render ANSI colors as span styles', async () => {
    render(<TerminalOutput output={'\u001b[31merror\u001b[0m ok'} />);

    const terminal = screen.getByTestId('terminal-output');
    await waitFor(() => expect(terminal.textContent).toContain('error'));
    expect(terminal.querySelector('span[style*="color"]')).toBeTruthy();
  });

  it('T-TO2 should preserve bold as font weight', async () => {
    render(<TerminalOutput output={'\u001b[1mbold\u001b[0m'} />);

    const terminal = screen.getByTestId('terminal-output');
    await waitFor(() => expect(terminal.textContent).toContain('bold'));
    const span = [...terminal.querySelectorAll('span')]
      .find((element) => element.textContent === 'bold');
    expect(span?.style.fontWeight).toBe('700');
  });

  it('T-TO3 should not leak non-display control sequences', async () => {
    render(<TerminalOutput output={'\u001b[2K\u001b[?25lclean text\u001b[?25h'} />);

    const terminal = screen.getByTestId('terminal-output');
    await waitFor(() => expect(terminal.textContent).toContain('clean text'));
    const text = terminal.textContent ?? '';
    expect(text).not.toContain('?25');
    expect(text).not.toContain('\u001b');
  });

  it('T-TO4 should escape HTML from terminal output (XSS)', async () => {
    render(<TerminalOutput output={'<img src=x onerror=alert(1)>'} />);

    const terminal = screen.getByTestId('terminal-output');
    await waitFor(() => expect(terminal.textContent).toContain('<img'));
    expect(terminal.querySelector('img')).toBeNull();
  });

  it('T-TO5 should keep empty lines and apply maxHeight', async () => {
    render(<TerminalOutput output={'line1\n\nline3'} maxHeight="12rem" />);

    const terminal = screen.getByTestId('terminal-output');
    await waitFor(() => expect(terminal.textContent).toContain('line3'));
    expect(terminal.style.maxHeight).toBe('12rem');
    expect(terminal.className).toContain('overflow-auto');

    const lines = screen.getAllByTestId('terminal-line');
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.className.includes('whitespace-pre'))).toBe(true);
    expect(lines[1].textContent).toBe(' ');
  });

  it('T-TO6 should render an empty output without crashing', () => {
    render(<TerminalOutput output="" />);

    expect(screen.getByTestId('terminal-output').textContent).toBe('');
    expect(screen.queryAllByTestId('terminal-line')).toHaveLength(0);
  });

  it('T-TO7 should only keep the final frame for progress output', async () => {
    render(<TerminalOutput output={'progress 10%\rprogress 55%\rprogress 100%'} />);

    const terminal = screen.getByTestId('terminal-output');
    await waitFor(() => expect(terminal.textContent).toContain('progress 100%'));
    expect(terminal.textContent).not.toContain('progress 10%');
    expect(terminal.textContent).not.toContain('progress 55%');
  });

  it('T-TO8 should keep the deep-black background regardless of UI theme', async () => {
    render(<TerminalOutput output={'theme check'} />);

    const terminal = screen.getByTestId('terminal-output');
    await waitFor(() => expect(terminal.textContent).toContain('theme check'));
    expect(getComputedStyle(terminal).backgroundColor).toBe('rgb(5, 5, 5)');

    document.documentElement.classList.add('dark');
    expect(getComputedStyle(terminal).backgroundColor).toBe('rgb(5, 5, 5)');
    document.documentElement.classList.remove('dark');
  });

  it('T-TO10 should keep the previous result until the next parse is ready', async () => {
    const { rerender } = render(<TerminalOutput output={'first frame'} />);
    const terminal = screen.getByTestId('terminal-output');
    await waitFor(() => expect(terminal.textContent).toContain('first frame'));

    rerender(<TerminalOutput output={'second frame'} />);
    // 防抖窗口内旧结果仍在，不闪空
    expect(terminal.textContent).toContain('first frame');

    await waitFor(() => expect(terminal.textContent).toContain('second frame'));
    expect(terminal.textContent).not.toContain('first frame');
  });
});
