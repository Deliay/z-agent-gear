// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../../MarkdownContent', () => ({
  default: ({ content, annotate }: { content: string; annotate?: boolean }) => (
    <div data-testid="mock-markdown" data-annotate={Boolean(annotate)}>
      {content}
    </div>
  ),
}));

import { MarkdownPreview } from '../MarkdownPreview';

function fakeSelection(anchorPos: string | null, focusPos: string | null) {
  const anchorEl = {
    nodeType: 1,
    closest: (_sel: string) => (anchorPos ? { getAttribute: () => anchorPos } : null),
  };
  const focusEl = {
    nodeType: 1,
    closest: (_sel: string) => (focusPos ? { getAttribute: () => focusPos } : null),
  };
  return {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: anchorEl,
    focusNode: focusEl,
    getRangeAt: () => ({ cloneRange: () => ({ surroundContents: vi.fn() }) }),
    removeAllRanges: vi.fn(),
  };
}

const SOURCE = '# Title\n\nHello **world**\n';

describe('MarkdownPreview（T-MDP / 返工 B1/B3）', () => {
  beforeEach(() => cleanup());

  it('T-MDP1 选区映射原文 → 弹层确认回传 AnnotationBatch{source:markdown}', async () => {
    const onConfirm = vi.fn();
    render(<MarkdownPreview source={SOURCE} filePath="a.md" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId('md-annotate-toggle'));
    expect(screen.getByTestId('mock-markdown')).toHaveAttribute('data-annotate', 'true');

    const getSelection = vi.fn().mockReturnValue(fakeSelection('3:1-3:6', '3:1-3:6'));
    vi.stubGlobal('getSelection', getSelection);
    // window.getSelection
    Object.defineProperty(window, 'getSelection', { value: getSelection, configurable: true });

    fireEvent.mouseUp(screen.getByTestId('md-content'));
    await screen.findByTestId('annotation-popup');
    fireEvent.change(screen.getByTestId('annotation-input'), { target: { value: '重写这段' } });
    fireEvent.click(screen.getByTestId('annotation-confirm'));

    fireEvent.click(screen.getByTestId('md-confirm'));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { source: 'markdown', filePath: 'a.md' },
        comments: [
          expect.objectContaining({
            anchor: expect.objectContaining({ kind: 'markdown', text: 'Hello', startOffset: 9, endOffset: 14 }),
            body: '重写这段',
          }),
        ],
      }),
    );
  });

  it('T-MDP3 不可映射 → 应用内 toast（B3：不再 window.alert）', () => {
    const onUnmappable = vi.fn();
    render(<MarkdownPreview source={SOURCE} onConfirm={vi.fn()} onUnmappable={onUnmappable} />);
    fireEvent.click(screen.getByTestId('md-annotate-toggle'));

    Object.defineProperty(window, 'getSelection', {
      value: vi.fn().mockReturnValue(fakeSelection(null, '3:1-3:6')),
      configurable: true,
    });
    fireEvent.mouseUp(screen.getByTestId('md-content'));
    expect(onUnmappable).toHaveBeenCalled();
  });

  it('B1：确认批注后包裹高亮覆盖层（md-annotation-highlight）', async () => {
    const surroundContents = vi.fn();
    render(<MarkdownPreview source={SOURCE} onConfirm={vi.fn()} />);
    fireEvent.click(screen.getByTestId('md-annotate-toggle'));

    Object.defineProperty(window, 'getSelection', {
      value: vi.fn().mockReturnValue({
        ...fakeSelection('3:1-3:6', '3:1-3:6'),
        getRangeAt: () => ({ cloneRange: () => ({ surroundContents }) }),
      }),
      configurable: true,
    });
    fireEvent.mouseUp(screen.getByTestId('md-content'));
    await screen.findByTestId('annotation-popup');
    fireEvent.change(screen.getByTestId('annotation-input'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('annotation-confirm'));
    expect(surroundContents).toHaveBeenCalled();
    const mark = surroundContents.mock.calls[0][0] as HTMLElement;
    expect(mark.tagName).toBe('MARK');
    expect(mark.className).toBe('md-annotation-highlight');
  });

  it('预览模式不注入 sourcepos（annotate=false）', () => {
    render(<MarkdownPreview source={SOURCE} onConfirm={vi.fn()} />);
    expect(screen.getByTestId('mock-markdown')).toHaveAttribute('data-annotate', 'false');
  });
});
