import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DeleteCloudHostDialog from '../DeleteCloudHostDialog';

const mockDeleteCloudHost = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: () => [mockDeleteCloudHost],
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
});
