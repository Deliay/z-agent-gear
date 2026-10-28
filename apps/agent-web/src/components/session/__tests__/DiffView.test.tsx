import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DiffView from '../DiffView';
import { MAX_DIFF_LINES } from '../../../lib/diff';

function lineNumbers(container: HTMLElement, kind: 'old' | 'new'): string[] {
  return [...container.querySelectorAll(`[data-testid="diff-${kind}-line-number"]`)]
    .map((el) => el.textContent?.trim() ?? '');
}

describe('DiffView', () => {
  it('should render oldText null as new-file full-add mode', () => {
    render(<DiffView oldText={null} newText={'line1\nline2'} filePath="src/new.ts" />);

    expect(screen.getByText('src/new.ts')).toBeDefined();
    expect(screen.getByText('新建文件')).toBeDefined();
    expect(screen.getByTestId('diff-view').textContent).toContain('line1');
    expect(screen.getByTestId('diff-view').textContent).toContain('line2');
  });

  it('should render modification diff when both texts present', () => {
    render(<DiffView oldText={'old line'} newText={'new line'} filePath="src/a.ts" />);

    const text = screen.getByTestId('diff-view').textContent ?? '';
    expect(text).toContain('old line');
    expect(text).toContain('new line');
  });

  it('should not mark an existing empty file as new file', () => {
    render(<DiffView oldText={''} newText={'line1'} filePath="src/empty.ts" />);

    expect(screen.getByText('src/empty.ts')).toBeDefined();
    expect(screen.queryByText('新建文件')).toBeNull();
  });

  it('should not render a pseudo removed first line for new files', () => {
    render(<DiffView oldText={null} newText={'line1\nline2'} filePath="src/new.ts" />);

    expect(screen.getByText('新建文件')).toBeDefined();
    expect(screen.queryByText('−')).toBeNull();
  });

  it('should break long file paths instead of overflowing the header', () => {
    const longPath = `src/${'deep/'.repeat(60)}file.ts`;
    render(<DiffView oldText={'a'} newText={'b'} filePath={longPath} />);

    expect(screen.getByText(longPath).className).toContain('break-all');
  });

  it('should render real old/new line numbers', () => {
    const { container } = render(<DiffView oldText={'a\nb\nc'} newText={'a\nx\nc'} filePath="src/a.ts" />);

    expect(lineNumbers(container, 'old')).toEqual(['1', '2', '', '3']);
    expect(lineNumbers(container, 'new')).toEqual(['1', '', '2', '3']);
  });

  it('should align inserted lines instead of shifting rows', () => {
    const { container } = render(<DiffView oldText={'a\nb'} newText={'a\nx\nb'} filePath="src/a.ts" />);
    const text = container.textContent ?? '';

    expect(lineNumbers(container, 'old')).toEqual(['1', '', '2']);
    expect(lineNumbers(container, 'new')).toEqual(['1', '2', '3']);
    expect(text).toContain('x');
  });

  it('should apply semantic colors to added and removed rows', () => {
    const { container } = render(<DiffView oldText={'old'} newText={'new'} filePath="src/a.ts" />);

    const removedRow = screen.getByText('−').parentElement as HTMLElement;
    const addedRow = screen.getByText('+').parentElement as HTMLElement;
    expect(removedRow.className).toContain('bg-destructive/10');
    expect(addedRow.className).toContain('bg-success/10');
    expect(container.querySelector('[data-testid="diff-view"]')).toBeTruthy();
  });

  it('should show a truncation notice for very large diffs', () => {
    const text = Array.from({ length: MAX_DIFF_LINES + 20 }, (_, i) => `line${i}`).join('\n');
    render(<DiffView oldText={''} newText={text} />);

    expect(screen.getByTestId('diff-truncated-notice')).toBeDefined();
  });

  it('should not render a false removed/added pair for an unchanged trailing line (R-6)', () => {
    render(<DiffView oldText={'1\n2\n3\n4'} newText={'1\n3\n4\n5'} filePath="src/a.ts" />);

    expect(screen.getAllByText('−')).toHaveLength(1);
    expect(screen.getAllByText('+')).toHaveLength(1);
  });

  it('should not render CRLF differences as a full rewrite (R-7)', () => {
    render(<DiffView oldText={'a\r\nb\r\n'} newText={'a\nb\n'} />);

    expect(screen.queryByText('−')).toBeNull();
    expect(screen.queryByText('+')).toBeNull();
    expect(screen.getByTestId('diff-view').textContent).not.toContain('\r');
  });
});
