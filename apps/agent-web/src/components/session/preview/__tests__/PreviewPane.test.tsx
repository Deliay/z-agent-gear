// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const fileQuery = vi.hoisted(() => ({
  data: {
    sessionFileContent: { path: 'src/a.ts', content: 'line1\nline2\n', truncated: false, sizeBytes: 11 },
  } as
    | { sessionFileContent?: { path: string; content: string; truncated: boolean; sizeBytes: number } }
    | undefined,
  loading: false,
  error: undefined as Error | undefined,
  refetch: vi.fn(),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (_query: unknown, options: { skip?: boolean } = {}) => {
    // FileTabContent 的 sessionFileContent 查询：状态由 fileQuery 控制（成功/加载中/失败）
    if (options.skip) return { data: undefined, loading: false, error: undefined, refetch: fileQuery.refetch };
    return { data: fileQuery.data, loading: fileQuery.loading, error: fileQuery.error, refetch: fileQuery.refetch };
  },
  useLazyQuery: () => [vi.fn(), { loading: false }],
}));

vi.mock('../CodePreview', () => ({
  CodePreview: (props: { filePath: string }) => <div data-testid="mock-code-preview">{props.filePath}</div>,
}));
vi.mock('../HtmlPreview', () => ({
  HtmlPreview: (props: { filePath?: string }) => <div data-testid="mock-html-preview">{props.filePath}</div>,
}));
vi.mock('../MarkdownPreview', () => ({
  MarkdownPreview: (props: { filePath?: string }) => <div data-testid="mock-md-preview">{props.filePath}</div>,
}));

import { PreviewPane } from '../PreviewPane';
import { getPreviewStore, destroyPreviewStore } from '../../../../stores/preview';

describe('PreviewPane（T-PANE / 返工 A1）', () => {
  beforeEach(() => {
    cleanup();
    destroyPreviewStore('pane-sess');
    fileQuery.data = {
      sessionFileContent: { path: 'src/a.ts', content: 'line1\nline2\n', truncated: false, sizeBytes: 11 },
    };
    fileQuery.loading = false;
    fileQuery.error = undefined;
    fileQuery.refetch.mockClear();
  });

  it('A1 高度链：根容器 h-full/flex-1（Monaco 可见前提）', () => {
    render(<PreviewPane sessionId="pane-sess" onAnnotation={vi.fn()} />);
    const root = screen.getByTestId('preview-pane');
    expect(root.className).toContain('h-full');
    expect(root.className).toContain('flex-1');
  });

  it('空态展示', () => {
    render(<PreviewPane sessionId="pane-sess" onAnnotation={vi.fn()} />);
    expect(screen.getByTestId('preview-empty')).toBeTruthy();
  });

  it('tab 渲染分流：.md→MarkdownPreview / .html→HtmlPreview / 其余→CodePreview', () => {
    const store = getPreviewStore('pane-sess');
    store.openFile({ filePath: 'src/a.md', pinned: false });
    render(<PreviewPane sessionId="pane-sess" onAnnotation={vi.fn()} />);
    expect(screen.getByTestId('mock-md-preview')).toBeTruthy();

    cleanup();
    destroyPreviewStore('pane-sess');
    getPreviewStore('pane-sess').openFile({ filePath: 'a.html', pinned: true });
    render(<PreviewPane sessionId="pane-sess" onAnnotation={vi.fn()} />);
    expect(screen.getByTestId('mock-html-preview')).toBeTruthy();

    cleanup();
    destroyPreviewStore('pane-sess');
    getPreviewStore('pane-sess').openFile({ filePath: 'src/a.ts', pinned: true });
    render(<PreviewPane sessionId="pane-sess" onAnnotation={vi.fn()} />);
    expect(screen.getByTestId('mock-code-preview')).toBeTruthy();
  });

  it('关闭 tab / 激活切换', async () => {
    const store = getPreviewStore('pane-sess');
    store.openFile({ filePath: 'src/a.ts', pinned: true });
    store.openFile({ filePath: 'src/b.ts', pinned: true });
    render(<PreviewPane sessionId="pane-sess" onAnnotation={vi.fn()} />);
    expect(screen.getAllByTestId('preview-tab')).toHaveLength(2);

    fireEvent.click(screen.getAllByTestId('preview-tab-close')[0]);
    await waitFor(() => expect(screen.getAllByTestId('preview-tab')).toHaveLength(1));
  });

  it('Review tab 渲染注入的 ReviewPanel（A1 review 包装 h-full）', () => {
    getPreviewStore('pane-sess').openReview('rev-1');
    render(
      <PreviewPane
        sessionId="pane-sess"
        onAnnotation={vi.fn()}
        renderReview={() => <div data-testid="mock-review" />}
      />,
    );
    expect(screen.getByTestId('mock-review')).toBeTruthy();
    const wrapper = screen.getByTestId('preview-review-tab');
    expect(wrapper.className).toContain('h-full');
    expect(wrapper.className).toContain('min-h-0');
  });

  it('查询失败展示错误态与重试（不再无限骨架）', () => {
    fileQuery.data = undefined;
    fileQuery.loading = false;
    fileQuery.error = new Error('Controller offline or file read timeout');
    getPreviewStore('pane-sess').openFile({ filePath: 'src/a.ts', pinned: false });

    render(<PreviewPane sessionId="pane-sess" onAnnotation={vi.fn()} />);

    expect(screen.queryByTestId('preview-skeleton')).toBeNull();
    const error = screen.getByTestId('preview-error');
    expect(error.textContent).toContain('加载失败');
    expect(error.textContent).toContain('Controller offline or file read timeout');
    fireEvent.click(screen.getByTestId('preview-retry'));
    expect(fileQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it('查询无数据且无错误（空响应）也按失败处理，不无限骨架', () => {
    fileQuery.data = undefined;
    fileQuery.loading = false;
    fileQuery.error = undefined;
    getPreviewStore('pane-sess').openFile({ filePath: 'src/a.ts', pinned: false });

    render(<PreviewPane sessionId="pane-sess" onAnnotation={vi.fn()} />);

    expect(screen.queryByTestId('preview-skeleton')).toBeNull();
    expect(screen.getByTestId('preview-error')).toBeTruthy();
  });

  it('查询中展示骨架屏', () => {
    fileQuery.data = undefined;
    fileQuery.loading = true;
    getPreviewStore('pane-sess').openFile({ filePath: 'src/a.ts', pinned: false });

    render(<PreviewPane sessionId="pane-sess" onAnnotation={vi.fn()} />);

    expect(screen.getByTestId('preview-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('preview-error')).toBeNull();
  });
});
