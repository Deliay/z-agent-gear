import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DeleteCloudHostDialog from '../DeleteCloudHostDialog';

const { mockDeleteCloudHost, mockCleanupLabels, mockUseQuery } = vi.hoisted(() => ({
  mockDeleteCloudHost: vi.fn(),
  mockCleanupLabels: vi.fn(),
  mockUseQuery: vi.fn(),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: () => mockUseQuery(),
  useMutation: (mutation: { definitions?: Array<{ name?: { value?: string } }> }) => {
    const name = mutation?.definitions?.[0]?.name?.value ?? '';
    return [name.includes('Cleanup') ? mockCleanupLabels : mockDeleteCloudHost];
  },
}));

const stoppedHost = {
  id: 'cloud-1',
  name: '云电脑 A',
  status: 'STOPPED' as const,
  deletedAt: null,
};

describe('DeleteCloudHostDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteCloudHost.mockResolvedValue({ data: { deleteCloudHost: true } });
    mockUseQuery.mockReturnValue({ data: { cloudHostIssuesLinkages: [] }, error: undefined });
  });

  it.each(['STOPPED', 'FAILED'] as const)('%s 可删除，二次确认后调用 mutation', async (status) => {
    const onDeleted = vi.fn();
    render(
      <DeleteCloudHostDialog
        open
        cloudHost={{ ...stoppedHost, status }}
        onClose={vi.fn()}
        onDeleted={onDeleted}
      />,
    );

    expect(screen.getByText(/确认删除？/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => {
      expect(mockDeleteCloudHost).toHaveBeenCalledWith({ variables: { id: 'cloud-1' } });
    });
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });

  it.each(['RUNNING', 'STOPPING', 'STARTING'] as const)('%s 不可删除，不提供确认按钮', (status) => {
    render(
      <DeleteCloudHostDialog
        open
        cloudHost={{ ...stoppedHost, status }}
        onClose={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );

    expect(screen.getByText(/不可删除，请先停止云电脑/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认删除' })).not.toBeInTheDocument();
    expect(mockDeleteCloudHost).not.toHaveBeenCalled();
  });

  it('删除失败时展示服务端错误', async () => {
    mockDeleteCloudHost.mockRejectedValueOnce(new Error('stop the cloud host before deleting'));

    render(
      <DeleteCloudHostDialog open cloudHost={stoppedHost} onClose={vi.fn()} onDeleted={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('stop the cloud host before deleting');
  });

  it('取消不调用 mutation', () => {
    const onClose = vi.fn();
    render(
      <DeleteCloudHostDialog open cloudHost={stoppedHost} onClose={onClose} onDeleted={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(mockDeleteCloudHost).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('存在联动配置时展示清理勾选项；勾选后先 cleanup 再删除', async () => {
    mockUseQuery.mockReturnValue({
      data: {
        cloudHostIssuesLinkages: [
          { id: 'l1' },
          { id: 'l2' },
        ],
      },
      error: undefined,
    });
    mockCleanupLabels.mockResolvedValue({
      data: { cleanupCloudHostIssuesLabels: { deleted: ['a/b#x'], failed: [] } },
    });
    const onDeleted = vi.fn();

    render(
      <DeleteCloudHostDialog
        open
        controllerId="ctrl-1"
        cloudHost={stoppedHost}
        onClose={vi.fn()}
        onDeleted={onDeleted}
      />,
    );

    fireEvent.click(screen.getByLabelText('同时删除已同步到仓库的标签'));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => {
      expect(mockCleanupLabels).toHaveBeenCalledWith({ variables: { controllerId: 'ctrl-1' } });
    });
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(mockDeleteCloudHost).toHaveBeenCalled();
  });

  it('清理失败项展示且不阻断删除（按钮变为仍要删除）', async () => {
    mockUseQuery.mockReturnValue({
      data: { cloudHostIssuesLinkages: [{ id: 'l1' }] },
      error: undefined,
    });
    mockCleanupLabels.mockResolvedValue({
      data: { cleanupCloudHostIssuesLabels: { deleted: [], failed: ['a/b#x'] } },
    });
    const onDeleted = vi.fn();

    render(
      <DeleteCloudHostDialog
        open
        controllerId="ctrl-1"
        cloudHost={stoppedHost}
        onClose={vi.fn()}
        onDeleted={onDeleted}
      />,
    );

    fireEvent.click(screen.getByLabelText('同时删除已同步到仓库的标签'));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    expect(await screen.findByText('a/b#x')).toBeInTheDocument();
    expect(mockDeleteCloudHost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '仍要删除' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });

  it('查询联动配置失败时降级为不展示勾选项（不阻断删除）', async () => {
    mockUseQuery.mockReturnValue({ data: undefined, error: new Error('boom') });
    render(
      <DeleteCloudHostDialog
        open
        controllerId="ctrl-1"
        cloudHost={stoppedHost}
        onClose={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('同时删除已同步到仓库的标签')).not.toBeInTheDocument();
  });
});
