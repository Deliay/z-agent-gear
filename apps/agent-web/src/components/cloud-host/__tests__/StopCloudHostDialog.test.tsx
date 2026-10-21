import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import StopCloudHostDialog from '../StopCloudHostDialog';

const mockUseQuery = vi.fn();
const mockStopCloudHost = vi.fn();
const mockRefetch = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [mockStopCloudHost],
}));

const cloudHost = { id: 'cloud-1', name: '云电脑 A' };

function mockImpact(activeSessionCount: number, sessions: Array<{ id: string; title: string; status: string; acpServerType: string }> = []) {
  mockUseQuery.mockReturnValue({
    data: {
      cloudHostStopImpact: {
        activeSessionCount,
        sessionsWillBeLost: activeSessionCount > 0,
        sessions,
      },
    },
    loading: false,
    error: undefined,
    refetch: mockRefetch,
  });
}

describe('StopCloudHostDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStopCloudHost.mockResolvedValue({
      data: {
        stopCloudHost: {
          id: 'cloud-1',
          name: '云电脑 A',
          status: 'STOPPED',
          harnessTypes: ['OPENCODE'],
          activeSessionCount: 0,
          failureReason: null,
          deletedAt: null,
        },
      },
    });
  });

  it('T-AW7 无活动会话时直接 stopCloudHost(force:false)，不展示告警', async () => {
    mockImpact(0);
    const onStopped = vi.fn();
    render(
      <StopCloudHostDialog open cloudHost={cloudHost} onClose={vi.fn()} onStopped={onStopped} />,
    );

    await waitFor(() => {
      expect(mockStopCloudHost).toHaveBeenCalledWith({
        variables: { id: 'cloud-1', force: false },
      });
    });
    expect(screen.queryByText('停止云主机会导致所有会话永久丢失，是否继续')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(onStopped).toHaveBeenCalledWith(expect.objectContaining({ status: 'STOPPED' }));
    });
  });

  it('T-AW8 有活动会话时展示逐字告警，取消不调用', async () => {
    mockImpact(2, [
      { id: 's1', title: '会话一', status: 'idling', acpServerType: 'opencode' },
      { id: 's2', title: '会话二', status: 'running', acpServerType: 'opencode' },
    ]);
    const onClose = vi.fn();

    render(
      <StopCloudHostDialog open cloudHost={cloudHost} onClose={onClose} onStopped={vi.fn()} />,
    );

    expect(await screen.findByText('停止云主机会导致所有会话永久丢失，是否继续')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(mockStopCloudHost).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('T-AW8 确认停止传 force:true', async () => {
    mockImpact(1, [
      { id: 's1', title: '会话一', status: 'idling', acpServerType: 'opencode' },
    ]);

    render(
      <StopCloudHostDialog open cloudHost={cloudHost} onClose={vi.fn()} onStopped={vi.fn()} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '继续停止' }));

    await waitFor(() => {
      expect(mockStopCloudHost).toHaveBeenCalledWith({
        variables: { id: 'cloud-1', force: true },
      });
    });
  });

  it('查询停止影响期间展示加载态', () => {
    mockUseQuery.mockReturnValue({ data: null, loading: true, error: undefined, refetch: vi.fn() });

    render(
      <StopCloudHostDialog open cloudHost={cloudHost} onClose={vi.fn()} onStopped={vi.fn()} />,
    );

    expect(screen.getByText('正在检查活动会话...')).toBeInTheDocument();
    expect(mockStopCloudHost).not.toHaveBeenCalled();
  });

  it('D-8 有活动会话时渲染会话摘要（标题 + 状态），文本按普通字符转义', async () => {
    mockImpact(2, [
      { id: 's1', title: '会话一', status: 'idling', acpServerType: 'opencode' },
      { id: 's2', title: '<script>alert(1)</script>', status: 'running', acpServerType: 'opencode' },
    ]);

    render(
      <StopCloudHostDialog open cloudHost={cloudHost} onClose={vi.fn()} onStopped={vi.fn()} />,
    );

    const summary = await screen.findByTestId('cloud-host-stop-sessions');
    expect(summary).toHaveTextContent('会话一');
    expect(summary).toHaveTextContent('idling');
    expect(summary).toHaveTextContent('<script>alert(1)</script>');
    expect(summary).toHaveTextContent('running');
    expect(summary.querySelector('script')).toBeNull();
  });

  it('D-8 有活动会话但 sessions 明细为空时展示空列表文案', async () => {
    mockImpact(2, []);

    render(
      <StopCloudHostDialog open cloudHost={cloudHost} onClose={vi.fn()} onStopped={vi.fn()} />,
    );

    expect(await screen.findByTestId('cloud-host-stop-sessions-empty')).toHaveTextContent('暂无会话明细');
  });

  it('D-8 stopCloudHost 返回空值时退出停止中并展示可重试错误', async () => {
    mockImpact(0);
    mockStopCloudHost.mockResolvedValueOnce({ data: { stopCloudHost: null } });
    const onStopped = vi.fn();

    render(
      <StopCloudHostDialog open cloudHost={cloudHost} onClose={vi.fn()} onStopped={onStopped} />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('停止云电脑失败，请重试');
    expect(onStopped).not.toHaveBeenCalled();
    expect(mockRefetch).toHaveBeenCalled();
    const retryButton = screen.getByRole('button', { name: '继续停止' });
    expect(retryButton).not.toBeDisabled();
    expect(screen.queryByText('停止中...')).not.toBeInTheDocument();
  });
});
