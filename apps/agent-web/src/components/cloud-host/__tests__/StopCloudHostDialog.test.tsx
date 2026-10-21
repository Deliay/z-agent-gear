import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import StopCloudHostDialog from '../StopCloudHostDialog';

const mockUseQuery = vi.fn();
const mockStopCloudHost = vi.fn();

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
    refetch: vi.fn(),
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
});
