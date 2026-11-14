// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// seam mock：记录 monaco 交互注册（A5 批注行选、B1 高亮装饰类）
const createdEditors: Array<Record<string, any>> = [];
const diffEditors: Array<Record<string, any>> = [];
const uriParses: string[] = [];

vi.mock('../../../../lib/preview/monaco-loader', () => ({
  loadMonaco: vi.fn(async () => ({
    Uri: { parse: (value: string) => { uriParses.push(value); return value; } },
    Range: class {
      constructor(_a: number, _b: number, _c: number, _d: number) {}
    },
    editor: {
      getModel: vi.fn(() => null),
      create: (_el: unknown, options: Record<string, unknown>) => {
        const editor = {
          options,
          onMouseDown: vi.fn(),
          revealLineInCenter: vi.fn(),
          deltaDecorations: vi.fn(() => ['dec-1']),
          saveViewState: vi.fn(() => ({ v: 1 })),
          restoreViewState: vi.fn(),
          dispose: vi.fn(),
        };
        createdEditors.push(editor);
        return editor;
      },
      createDiffEditor: (_el: unknown, options: Record<string, unknown>) => {
        // 真实 monaco（0.57）行为：diff 由 worker 异步计算，`setModel` 之后
        // 立刻调用 `getLineChanges()` 返回 null，计算完成后才触发 `onDidUpdateDiff`。
        const diffListeners: Array<() => void> = [];
        let lineChanges: Array<{ modifiedStartLineNumber: number }> | null = null;
        const modified = {
          onMouseDown: vi.fn(),
          revealLineInCenter: vi.fn(),
          deltaDecorations: vi.fn(() => ['dec-1']),
          dispose: vi.fn(),
        };
        const original = { dispose: vi.fn() };
        const diff = {
          options,
          getModifiedEditor: () => modified,
          setModel: vi.fn(() => {
            setTimeout(() => {
              lineChanges = [{ modifiedStartLineNumber: 5 }];
              for (const listener of [...diffListeners]) listener();
            }, 0);
          }),
          getLineChanges: () => lineChanges,
          onDidUpdateDiff: (listener: () => void) => {
            diffListeners.push(listener);
            return {
              dispose: () => {
                const index = diffListeners.indexOf(listener);
                if (index >= 0) diffListeners.splice(index, 1);
              },
            };
          },
          dispose: vi.fn(),
        };
        diffEditors.push({ diff, modified, original });
        return diff;
      },
      createModel: vi.fn(() => ({ dispose: vi.fn(), setValue: vi.fn() })),
    },
  })),
}));

import { CodePreview, resetCodePreviewModels } from '../CodePreview';

describe('CodePreview（T-CP / 返工 A1/A5/B1/B2）', () => {
  beforeEach(() => {
    cleanup();
    createdEditors.length = 0;
    diffEditors.length = 0;
    uriParses.length = 0;
    resetCodePreviewModels();
    vi.clearAllMocks();
  });

  it('绝对路径生成合法 file URI（避免 // 开头的非法 path 触发 UriError）', async () => {
    render(<CodePreview filePath="/home/worker/workspace/src/a.ts" content="x" onConfirm={vi.fn()} />);
    await waitFor(() => expect(uriParses.length).toBe(1));
    expect(uriParses[0]).toBe('file:///home/worker/workspace/src/a.ts');
  });

  it('A1 高度链：根容器 h-full，编辑器宿主 flex-1（Monaco 可见前提）', () => {
    render(<CodePreview filePath="a.ts" content="x" onConfirm={vi.fn()} />);
    const root = screen.getByTestId('code-preview');
    expect(root.className).toContain('h-full');
    expect(screen.getByTestId('code-editor-host').parentElement?.className).toContain('flex-1');
  });

  it('B2：readOnly 时批注入口仍可用（内容只读、批注恒可用）', () => {
    render(<CodePreview filePath="a.ts" content="x" readOnly onConfirm={vi.fn()} />);
    expect(screen.getByTestId('code-annotate-toggle')).toBeTruthy();
  });

  it('A5：普通模式点击行打开批注弹层并回传 AnnotationBatch', async () => {
    const onConfirm = vi.fn();
    render(<CodePreview filePath="src/a.ts" content="x" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId('code-annotate-toggle'));
    await waitFor(() => expect(createdEditors.length).toBe(1));

    // 行选注册（A5 同源绑定）
    expect(createdEditors[0].onMouseDown).toHaveBeenCalled();
    const handler = createdEditors[0].onMouseDown.mock.calls[0][0];
    handler({ target: { position: { lineNumber: 12 } }, event: { shiftKey: false } });

    await screen.findByTestId('annotation-popup');
    fireEvent.change(screen.getByTestId('annotation-input'), { target: { value: 'fix it' } });
    fireEvent.click(screen.getByTestId('annotation-confirm'));

    fireEvent.click(screen.getByTestId('code-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({
      target: { source: 'code', filePath: 'src/a.ts' },
      comments: [expect.objectContaining({
        anchor: { kind: 'code', filePath: 'src/a.ts', startLine: 12, endLine: 12 },
        body: 'fix it',
      })],
    });
  });

  it('A5：diff 模式行选绑定到 modified 编辑器（批注可用）', async () => {
    render(<CodePreview filePath="src/a.ts" content="new" oldText="old" onConfirm={vi.fn()} />);
    fireEvent.click(screen.getByTestId('code-annotate-toggle'));
    await waitFor(() => expect(diffEditors.length).toBe(1));

    expect(diffEditors[0].modified.onMouseDown).toHaveBeenCalled();
    const handler = diffEditors[0].modified.onMouseDown.mock.calls[0][0];
    handler({ target: { position: { lineNumber: 5 } }, event: { shiftKey: false } });
    await screen.findByTestId('annotation-popup');
  });

  it('B1：行定位高亮装饰使用 zag-focus-highlight/zag-focus-marker 类', async () => {
    render(<CodePreview filePath="a.ts" content="x" focusLine={3} onConfirm={vi.fn()} />);
    await waitFor(() => expect(createdEditors.length).toBe(1));
    await waitFor(() => expect(createdEditors[0].revealLineInCenter).toHaveBeenCalledWith(3));
    expect(createdEditors[0].deltaDecorations).toHaveBeenCalledWith([], [
      expect.objectContaining({ options: expect.objectContaining({ className: 'zag-focus-highlight' }) }),
    ]);
  });

  it('#481：diff 异步计算完成后聚焦首个差异块', async () => {
    render(<CodePreview filePath="src/a.ts" content="new" oldText="old" onConfirm={vi.fn()} />);
    await waitFor(() => expect(diffEditors.length).toBe(1));
    const { modified } = diffEditors[0];
    // 复现：setModel 后同步取 lineChanges 得到 null，修复前永不聚焦（scrollTop 停在 0）
    await waitFor(() => expect(modified.revealLineInCenter).toHaveBeenCalledWith(5));
  });

  it('#481：diff 模式下调用方给定的 focusLine 优先于首个差异块', async () => {
    render(<CodePreview filePath="src/a.ts" content="new" oldText="old" focusLine={120} onConfirm={vi.fn()} />);
    await waitFor(() => expect(diffEditors.length).toBe(1));
    const { modified } = diffEditors[0];
    await waitFor(() => expect(modified.revealLineInCenter).toHaveBeenCalledWith(120));
    // 差异块异步计算完成后不得把视口从 focusLine 拉回首行
    await waitFor(() => expect(diffEditors[0].diff.getLineChanges()).not.toBeNull());
    expect(modified.revealLineInCenter).not.toHaveBeenCalledWith(5);
  });

  it('Shift 连选：范围扩展为 startLine-endLine', async () => {
    const onConfirm = vi.fn();
    render(<CodePreview filePath="a.ts" content="x" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId('code-annotate-toggle'));
    await waitFor(() => expect(createdEditors.length).toBe(1));
    const handler = createdEditors[0].onMouseDown.mock.calls[0][0];
    handler({ target: { position: { lineNumber: 3 } }, event: { shiftKey: false } });
    handler({ target: { position: { lineNumber: 6 } }, event: { shiftKey: true } });
    await screen.findByTestId('annotation-popup');
    fireEvent.change(screen.getByTestId('annotation-input'), { target: { value: 'range' } });
    fireEvent.click(screen.getByTestId('annotation-confirm'));
    fireEvent.click(screen.getByTestId('code-confirm'));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      comments: [expect.objectContaining({ anchor: expect.objectContaining({ startLine: 3, endLine: 6 }) })],
    }));
  });

  it('truncated 顶部提示条', () => {
    render(<CodePreview filePath="a.ts" content="x" truncated onConfirm={vi.fn()} />);
    expect(screen.getByTestId('code-truncated')).toBeTruthy();
  });
});
