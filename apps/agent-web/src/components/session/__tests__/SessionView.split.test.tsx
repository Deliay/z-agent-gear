// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import SessionView from '../SessionView';
import { GET_SESSION, GET_CONTROLLERS } from '../../../graphql/queries';
import { GET_SESSION_REVIEWS } from '../../../graphql/preview';
import { getPreviewStore, destroyPreviewStore } from '../../../stores/preview';

const mockUseQuery = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [vi.fn().mockResolvedValue({ data: {} }), { loading: false }],
  useApolloClient: () => ({ query: vi.fn() }),
}));

vi.mock('../MessageList', () => ({ default: () => <div data-testid="message-list" /> }));
vi.mock('../InputBox', () => ({ default: () => <textarea data-testid="input-box" /> }));
vi.mock('../ResumeConfirmDialog', () => ({ default: () => null }));

class MockEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  url: string;
  constructor(url: string) {
    this.url = url;
  }
}
vi.stubGlobal('EventSource', MockEventSource);

function sessionData(id: string) {
  return {
    id,
    userId: 'u1',
    controllerId: 'c1',
    controllerName: 'ctrl',
    acpServerType: 'opencode',
    status: 'idling',
    title: 's',
    externalSessionId: null,
    cwd: '/ws',
    worktreePath: null,
    worktreeBranch: null,
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    promptCapabilities: null,
  };
}

let reviewStatusRows: Array<{ id: string; status: string }> = [];
let reviewOnCompleted: ((data: unknown) => void) | null = null;

function installQueryMock(sessionId: string) {
  mockUseQuery.mockImplementation((query: unknown, options: Record<string, any> = {}) => {
    if (query === GET_SESSION) {
      return { data: { session: sessionData(sessionId) }, loading: false, error: undefined };
    }
    if (query === GET_CONTROLLERS) {
      return { data: { controllers: [] }, loading: false };
    }
    if (query === GET_SESSION_REVIEWS) {
      reviewOnCompleted = options.onCompleted ?? null;
      queueMicrotask(() => reviewOnCompleted?.({ sessionReviews: reviewStatusRows }));
      return { data: { sessionReviews: reviewStatusRows }, loading: false, refetch: vi.fn() };
    }
    return { data: undefined, loading: false };
  });
}

describe('SessionView 分屏 / Review 状态 / 会话切换（T-SVIEW / 返工 A2/A4）', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    // 默认宽视口（≥1024px）
    Object.defineProperty(window, 'matchMedia', {
      value: (query: string) => ({
        matches: true,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      configurable: true,
    });
    window.history.replaceState({}, '', '/sessions/sess-a');
    for (const id of ['sess-a', 'sess-b']) destroyPreviewStore(id);
    reviewStatusRows = [];
  });

  it('T-SVIEW1 grid 三模式类名随偏好切换', async () => {
    localStorage.setItem('session-split-mode:sess-a', 'horizontal');
    installQueryMock('sess-a');
    render(<SessionView sessionId="sess-a" />);

    const root = screen.getByTestId('session-split-root');
    expect(root.getAttribute('data-split-mode')).toBe('horizontal');
    expect(root.className).toContain('grid-cols-[4fr_6fr]');

    fireEvent.click(screen.getByTestId('split-mode-vertical'));
    expect(root.getAttribute('data-split-mode')).toBe('vertical');
    expect(root.className).toContain('grid-rows-[3fr_7fr]');

    fireEvent.click(screen.getByTestId('split-mode-chat'));
    expect(root.getAttribute('data-split-mode')).toBe('chat');
    expect(screen.queryByTestId('preview-pane')).toBeNull();
  });

  it('T-SVIEW2 窄视口偏好 horizontal 渲染 vertical 且不改写偏好', () => {
    localStorage.setItem('session-split-mode:sess-a', 'horizontal');
    installQueryMock('sess-a');
    // matchMedia 窄视口
    Object.defineProperty(window, 'matchMedia', {
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      configurable: true,
    });
    render(<SessionView sessionId="sess-a" />);
    expect(screen.getByTestId('session-split-root').getAttribute('data-split-mode')).toBe('vertical');
    expect(localStorage.getItem('session-split-mode:sess-a')).toBe('horizontal');
  });

  it('A2：review 状态色接通（sessionReviews → PreviewTabBar 四态色）', async () => {
    localStorage.setItem('session-split-mode:sess-a', 'horizontal');
    reviewStatusRows = [{ id: 'rev-1', status: 'PENDING' }];
    installQueryMock('sess-a');
    getPreviewStore('sess-a').openReview('rev-1');

    render(<SessionView sessionId="sess-a" />);
    await waitFor(() =>
      expect(screen.getByTestId('review-tab-status')).toHaveAttribute('data-review-status', 'PENDING'),
    );

    // 状态推进（SSE/轮询经 onCompleted 到达）→ 标签色跟随
    reviewStatusRows = [{ id: 'rev-1', status: 'APPROVED' }];
    await reviewOnCompleted?.({ sessionReviews: reviewStatusRows });
    await waitFor(() =>
      expect(screen.getByTestId('review-tab-status')).toHaveAttribute('data-review-status', 'APPROVED'),
    );
  });

  it('T-DLINK/A4：?review= 深链消费并清参；会话切换（重挂载）重新读取偏好与深链', async () => {
    // 会话 A：深链 review-a
    window.history.replaceState({}, '', '/sessions/sess-a?review=rev-a');
    localStorage.setItem('session-split-mode:sess-a', 'chat');
    installQueryMock('sess-a');
    const first = render(<SessionView sessionId="sess-a" />);
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(getPreviewStore('sess-a').getSnapshot().tabs.some((tab) => tab.kind === 'review')).toBe(true);

    // 切换到会话 B（key 重挂载语义：卸载 + 挂载）：偏好与深链重新读取
    first.unmount();
    destroyPreviewStore('sess-a');
    window.history.replaceState({}, '', '/sessions/sess-b?review=rev-b');
    localStorage.setItem('session-split-mode:sess-b', 'vertical');
    installQueryMock('sess-b');
    render(<SessionView sessionId="sess-b" />);

    await waitFor(() =>
      expect(getPreviewStore('sess-b').getSnapshot().tabs.some((tab) => tab.kind === 'review')).toBe(true),
    );
    expect(screen.getByTestId('session-split-root').getAttribute('data-split-mode')).toBe('vertical');
  });
});

describe('Review 深链响应式消费（返工 A1）', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      value: (query: string) => ({
        matches: true,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      configurable: true,
    });
    window.history.replaceState({}, '', '/sessions/sess-a');
    destroyPreviewStore('sess-a');
  });

  it('同会话二次深链（不重挂载）打开第二个 Review 标签', async () => {
    installQueryMock('sess-a');
    render(<SessionView sessionId="sess-a" />);

    // SPA 导航至 ?review=rev-1（同会话、不重挂载）
    window.history.pushState({}, '', '/sessions/sess-a?review=rev-1');
    await waitFor(() =>
      expect(getPreviewStore('sess-a').getSnapshot().tabs.some((tab) => tab.kind === 'review' && (tab as { reviewId: string }).reviewId === 'rev-1')).toBe(true),
    );
    // 消费后清参
    await waitFor(() => expect(window.location.search).toBe(''));

    // 再次导航至 ?review=rev-2：仍应打开第二个 Review 标签
    window.history.pushState({}, '', '/sessions/sess-a?review=rev-2');
    await waitFor(() =>
      expect(getPreviewStore('sess-a').getSnapshot().tabs.some((tab) => tab.kind === 'review' && (tab as { reviewId: string }).reviewId === 'rev-2')).toBe(true),
    );
    const reviewIds = getPreviewStore('sess-a')
      .getSnapshot()
      .tabs.filter((tab) => tab.kind === 'review')
      .map((tab) => (tab as { reviewId: string }).reviewId);
    expect(reviewIds).toEqual(['rev-1', 'rev-2']);
  });
});
