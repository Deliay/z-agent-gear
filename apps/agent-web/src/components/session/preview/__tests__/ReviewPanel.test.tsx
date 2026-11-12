// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const submitReview = vi.fn().mockResolvedValue({ data: {} });
let reviewRow: Record<string, unknown> | null = null;
let commentSeq = 0;

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
  useQuery: (query: unknown) => {
    const label = String((query as { loc?: { source?: { body?: string } } })?.loc?.source?.body ?? '');
    if (label.includes('SessionFileContent')) {
      return { data: fileQuery.data, loading: fileQuery.loading, error: fileQuery.error, refetch: fileQuery.refetch };
    }
    return { data: { sessionReview: reviewRow }, loading: false };
  },
  useMutation: () => [submitReview, { loading: false }],
}));

// 内容组件 seam：可注入批注（锚定自身 filePath，用于 A2 隔离断言）
vi.mock('../CodePreview', () => ({
  CodePreview: (props: { filePath: string; onConfirm: (batch: unknown) => void }) => (
    <div data-testid={`mock-code-${props.filePath}`}>
      <button
        type="button"
        data-testid="mock-annotate"
        onClick={() =>
          props.onConfirm({
            target: { source: 'code', filePath: props.filePath },
            comments: [
              {
                id: `c-${props.filePath}-${(commentSeq += 1)}`,
                anchor: { kind: 'code', filePath: props.filePath, startLine: 1, endLine: 1 },
                body: `issue in ${props.filePath} #${commentSeq}`,
                createdAt: '2026-11-06T00:00:00Z',
              },
            ],
          })
        }
      >
        mock-annotate
      </button>
    </div>
  ),
}));
vi.mock('../HtmlPreview', () => ({ HtmlPreview: () => <div data-testid="mock-html" /> }));
vi.mock('../MarkdownPreview', () => ({ MarkdownPreview: () => <div data-testid="mock-md" /> }));

import { ReviewPanel } from '../ReviewPanel';

function pendingReview() {
  return {
    id: 'rev-1',
    sessionId: 'sess-1',
    files: ['src/a.ts', 'src/b.ts'],
    status: 'PENDING',
    fileReviews: null,
    comment: null,
    cancelReason: null,
    createdAt: '2026-11-06T00:00:00Z',
    resolvedAt: null,
  };
}

describe('ReviewPanel（B4 提交三态/只读化；A2 跨文件批注隔离）', () => {
  beforeEach(() => {
    cleanup();
    submitReview.mockClear();
    reviewRow = pendingReview();
    fileQuery.data = {
      sessionFileContent: { path: 'src/a.ts', content: 'line1\nline2\n', truncated: false, sizeBytes: 11 },
    };
    fileQuery.loading = false;
    fileQuery.error = undefined;
    fileQuery.refetch.mockClear();
  });

  it('B4 提交三态：approve/reject/comment 携带 fileReviews/comment/status', async () => {
    render(<ReviewPanel reviewId="rev-1" sessionId="sess-1" />);
    fireEvent.change(screen.getByTestId('review-summary'), { target: { value: 'lgtm' } });

    fireEvent.click(screen.getByTestId('review-approve'));
    await waitFor(() => expect(submitReview).toHaveBeenCalledTimes(1));
    expect(submitReview.mock.calls[0][0].variables).toMatchObject({
      id: 'rev-1',
      input: { comment: 'lgtm', status: 'approve' },
    });

    fireEvent.click(screen.getByTestId('review-reject'));
    expect(submitReview.mock.calls[1][0].variables.input.status).toBe('reject');

    fireEvent.click(screen.getByTestId('review-comment'));
    expect(submitReview.mock.calls[2][0].variables.input.status).toBe('comment');
  });

  it('B4 只读化：非 PENDING 展示结论徽标与只读块，无提交按钮', () => {
    reviewRow = { ...pendingReview(), status: 'APPROVED', comment: 'ok', resolvedAt: '2026-11-06T01:00:00Z' };
    render(<ReviewPanel reviewId="rev-1" sessionId="sess-1" />);
    expect(screen.getByTestId('review-status-badge').textContent).toContain('已通过');
    expect(screen.getByTestId('review-resolved')).toBeTruthy();
    expect(screen.queryByTestId('review-approve')).toBeNull();
    expect(screen.queryByTestId('review-reject')).toBeNull();
    expect(screen.queryByTestId('review-comment')).toBeNull();
  });

  it('A2 跨文件批注隔离：切文件 key 重建，file_reviews 按文件正确聚合不串文件', async () => {
    render(<ReviewPanel reviewId="rev-1" sessionId="sess-1" />);
    // a.ts 批注（进入 fileReviews['src/a.ts']）
    fireEvent.click(screen.getByTestId('mock-annotate'));
    await waitFor(() => expect(screen.getByTestId('mock-code-src/a.ts')).toBeTruthy());

    // 切到 b.ts：key 重建（a 的组件实例销毁，未确认批注不残留到 b）
    fireEvent.click(screen.getAllByTestId('review-file-item')[1]);
    await waitFor(() => expect(screen.getByTestId('mock-code-src/b.ts')).toBeTruthy());
    expect(screen.queryByTestId('mock-code-src/a.ts')).toBeNull();

    // b.ts 批注后提交：两文件各自聚合、互不串扰、无重复
    fireEvent.click(screen.getByTestId('mock-annotate'));
    fireEvent.click(screen.getByTestId('review-approve'));
    await waitFor(() => expect(submitReview).toHaveBeenCalledTimes(1));
    const fileReviews = submitReview.mock.calls[0][0].variables.input.fileReviews as Record<string, unknown[]>;
    expect(Object.keys(fileReviews).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(fileReviews['src/a.ts']).toHaveLength(1);
    expect(fileReviews['src/b.ts']).toHaveLength(1);
    expect((fileReviews['src/a.ts'][0] as { body: string }).body).toContain('issue in src/a.ts');
    expect((fileReviews['src/b.ts'][0] as { body: string }).body).toContain('issue in src/b.ts');
  });

  it('A1 同文件多轮批注聚合不丢失（确认后清空 + 合并追加）', async () => {
    render(<ReviewPanel reviewId="rev-1" sessionId="sess-1" />);
    // 第一轮 c1
    fireEvent.click(screen.getByTestId('mock-annotate'));
    // 第二轮 c2（组件确认后清空，ReviewPanel 合并追加）
    fireEvent.click(screen.getByTestId('mock-annotate'));
    fireEvent.click(screen.getByTestId('review-approve'));
    await waitFor(() => expect(submitReview).toHaveBeenCalledTimes(1));
    const fileReviews = submitReview.mock.calls[0][0].variables.input.fileReviews as Record<string, unknown[]>;
    expect(fileReviews['src/a.ts']).toHaveLength(2);
    const bodies = fileReviews['src/a.ts'].map((comment) => (comment as { body: string }).body);
    expect(new Set(bodies).size).toBe(2);
  });

  it('A1 切文件往返后继续批注聚合（key 重建不丢既有批注）', async () => {
    render(<ReviewPanel reviewId="rev-1" sessionId="sess-1" />);
    fireEvent.click(screen.getByTestId('mock-annotate')); // a.ts 第 1 条
    // 往返切换（key 重建）
    fireEvent.click(screen.getAllByTestId('review-file-item')[1]);
    await waitFor(() => expect(screen.getByTestId('mock-code-src/b.ts')).toBeTruthy());
    fireEvent.click(screen.getAllByTestId('review-file-item')[0]);
    await waitFor(() => expect(screen.getByTestId('mock-code-src/a.ts')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mock-annotate')); // a.ts 第 2 条（往返后）

    fireEvent.click(screen.getByTestId('review-approve'));
    await waitFor(() => expect(submitReview).toHaveBeenCalledTimes(1));
    const fileReviews = submitReview.mock.calls[0][0].variables.input.fileReviews as Record<string, unknown[]>;
    expect(fileReviews['src/a.ts']).toHaveLength(2);
  });

  it('Review 场景批注不回传输入区（B5-1）', async () => {
    const onAnnotation = vi.fn();
    render(<ReviewPanel reviewId="rev-1" sessionId="sess-1" onAnnotation={onAnnotation} />);
    fireEvent.click(screen.getByTestId('mock-annotate'));
    fireEvent.click(screen.getByTestId('review-approve'));
    await waitFor(() => expect(submitReview).toHaveBeenCalledTimes(1));
    expect(onAnnotation).not.toHaveBeenCalled();
  });

  it('文件内容加载失败展示错误态与重试（不再无限骨架）', () => {
    fileQuery.data = undefined;
    fileQuery.loading = false;
    fileQuery.error = new Error('Controller offline or file read timeout');
    render(<ReviewPanel reviewId="rev-1" sessionId="sess-1" />);

    expect(screen.queryByTestId('review-file-skeleton')).toBeNull();
    const error = screen.getByTestId('review-file-error');
    expect(error.textContent).toContain('加载失败');
    fireEvent.click(screen.getByTestId('review-file-retry'));
    expect(fileQuery.refetch).toHaveBeenCalledTimes(1);
  });

  it('文件内容空响应也按失败处理，不无限骨架', () => {
    fileQuery.data = undefined;
    fileQuery.loading = false;
    fileQuery.error = undefined;
    render(<ReviewPanel reviewId="rev-1" sessionId="sess-1" />);

    expect(screen.queryByTestId('review-file-skeleton')).toBeNull();
    expect(screen.getByTestId('review-file-error')).toBeTruthy();
  });
});
