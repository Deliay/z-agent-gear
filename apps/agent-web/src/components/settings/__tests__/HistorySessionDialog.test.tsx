import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HistorySessionDialog from '../HistorySessionDialog';

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

function baseSessions() {
  return [
    { sessionId: 'hist-1', title: 'Session One', cwd: '/home/user', updatedAt: '2026-01-01T00:00:00Z' },
    { sessionId: 'hist-2', title: 'Session Two', cwd: '/home/user', updatedAt: '2026-01-02T00:00:00Z' },
  ];
}

describe('HistorySessionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue([vi.fn().mockResolvedValue({ data: { importHistorySessions: [] } })]);
  });

  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    controllerId: 'ctrl-1',
    workspaceId: 'ws-1',
    workspaceName: 'My Project',
  };

  it('should show loading state', () => {
    mockUseQuery.mockReturnValue({ data: null, loading: true, error: null });

    render(<HistorySessionDialog {...defaultProps} />);

    expect(screen.getByText('加载中...')).toBeDefined();
  });

  it('should show empty state when no sessions', () => {
    mockUseQuery.mockReturnValue({ data: { listHistorySessions: [] }, loading: false, error: null });

    render(<HistorySessionDialog {...defaultProps} />);

    expect(screen.getByText('该工作目录下没有未导入的历史会话')).toBeDefined();
  });

  it('should show error state', () => {
    mockUseQuery.mockReturnValue({ data: null, loading: false, error: new Error('Controller offline') });

    render(<HistorySessionDialog {...defaultProps} />);

    expect(screen.getByText(/获取历史会话列表失败/)).toBeDefined();
  });

  it('should display session list with titles', () => {
    mockUseQuery.mockReturnValue({ data: { listHistorySessions: baseSessions() }, loading: false, error: null });

    render(<HistorySessionDialog {...defaultProps} />);

    expect(screen.getByText('Session One')).toBeDefined();
    expect(screen.getByText('Session Two')).toBeDefined();
  });

  it('should show session count', () => {
    mockUseQuery.mockReturnValue({ data: { listHistorySessions: baseSessions() }, loading: false, error: null });

    render(<HistorySessionDialog {...defaultProps} />);

    expect(screen.getByText('2 个可导入的会话')).toBeDefined();
  });

  it('should show dialog title with workspace name', () => {
    mockUseQuery.mockReturnValue({ data: { listHistorySessions: baseSessions() }, loading: false, error: null });

    render(<HistorySessionDialog {...defaultProps} />);

    expect(screen.getByText('历史会话 - My Project')).toBeDefined();
  });

  it('should disable import button when no session selected', () => {
    mockUseQuery.mockReturnValue({ data: { listHistorySessions: baseSessions() }, loading: false, error: null });

    render(<HistorySessionDialog {...defaultProps} />);

    const importBtn = screen.getByText('导入已选 (0)') as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
  });

  it('should enable import button when sessions selected', () => {
    mockUseQuery.mockReturnValue({ data: { listHistorySessions: baseSessions() }, loading: false, error: null });

    render(<HistorySessionDialog {...defaultProps} />);

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);

    const importBtn = screen.getByText('导入已选 (1)') as HTMLButtonElement;
    expect(importBtn.disabled).toBe(false);
  });

  it('should select all sessions when clicking select all', () => {
    mockUseQuery.mockReturnValue({ data: { listHistorySessions: baseSessions() }, loading: false, error: null });

    render(<HistorySessionDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('全选'));

    const importBtn = screen.getByText('导入已选 (2)') as HTMLButtonElement;
    expect(importBtn.disabled).toBe(false);
  });

  it('should show fallback title when session has no title', () => {
    const sessions = [{ sessionId: 'abc12345', title: null, cwd: '/home/user', updatedAt: null }];
    mockUseQuery.mockReturnValue({ data: { listHistorySessions: sessions }, loading: false, error: null });

    render(<HistorySessionDialog {...defaultProps} />);

    expect(screen.getByText(/abc12345/)).toBeDefined();
  });

  it('should not trigger query when dialog is closed', () => {
    mockUseQuery.mockReset();
    mockUseQuery.mockReturnValue({ data: null, loading: false, error: null });

    render(<HistorySessionDialog {...defaultProps} open={false} workspaceId="" />);

    expect(screen.queryByText('历史会话 - My Project')).toBeNull();
  });

  it('should show progress text during import', async () => {
    const importMock = vi.fn().mockResolvedValue({
      data: {
        importHistorySessions: [
          { sessionId: 'sess-1', acpSessionId: 'hist-1', title: 'Session One', success: true, error: null, messageCount: 3 },
          { sessionId: 'sess-2', acpSessionId: 'hist-2', title: 'Session Two', success: true, error: null, messageCount: 5 },
        ],
      },
    });
    mockUseMutation.mockReturnValue([importMock]);
    mockUseQuery.mockReturnValue({ data: { listHistorySessions: baseSessions() }, loading: false, error: null });

    render(<HistorySessionDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('全选'));
    fireEvent.click(screen.getByText('导入已选 (2)'));

    expect(await screen.findByText('成功导入 2 个会话')).toBeDefined();
  });

  it('should show error details for failed imports', async () => {
    const importMock = vi.fn().mockResolvedValue({
      data: {
        importHistorySessions: [
          { sessionId: '', acpSessionId: 'hist-1', title: 'Session One', success: false, error: 'ACP timeout', messageCount: 0 },
        ],
      },
    });
    mockUseMutation.mockReturnValue([importMock]);
    mockUseQuery.mockReturnValue({ data: { listHistorySessions: baseSessions() }, loading: false, error: null });

    render(<HistorySessionDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('全选'));
    fireEvent.click(screen.getByText('导入已选 (2)'));

    expect(await screen.findByText(/ACP timeout/)).toBeDefined();
  });

  it('should show "完成" button after import', async () => {
    const importMock = vi.fn().mockResolvedValue({
      data: {
        importHistorySessions: [
          { sessionId: 'sess-1', acpSessionId: 'hist-1', title: 'Session One', success: true, error: null, messageCount: 3 },
        ],
      },
    });
    mockUseMutation.mockReturnValue([importMock]);
    mockUseQuery.mockReturnValue({ data: { listHistorySessions: baseSessions() }, loading: false, error: null });

    render(<HistorySessionDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('全选'));
    fireEvent.click(screen.getByText('导入已选 (2)'));

    expect(await screen.findByText('完成')).toBeDefined();
    expect(screen.queryByText('关闭')).toBeNull();
  });
});
