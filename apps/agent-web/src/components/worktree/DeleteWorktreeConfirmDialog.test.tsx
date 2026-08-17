import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import DeleteWorktreeConfirmDialog from './DeleteWorktreeConfirmDialog';

const mockDeleteWorktree = vi.fn();
const mockNavigate = vi.fn();
let mockPathname = '/';

vi.mock('@apollo/client/react', () => ({
  useMutation: () => [mockDeleteWorktree],
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: mockPathname }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function renderDialog(props: Partial<Parameters<typeof DeleteWorktreeConfirmDialog>[0]> = {}) {
  return render(
    <DeleteWorktreeConfirmDialog
      open
      onOpenChange={vi.fn()}
      controllerId="ctrl-1"
      workspaceId="ws-1"
      worktreePath="/repo/.worktrees/feat-a"
      sessionCount={1}
      workspaceName="my-repo"
      {...props}
    />,
  );
}

function mockResult(deleteWorktree: Record<string, unknown>) {
  mockDeleteWorktree.mockResolvedValue({ data: { deleteWorktree } });
}

describe('DeleteWorktreeConfirmDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/';
  });

  it('弹框文案包含所属 workspace 名称', () => {
    mockDeleteWorktree.mockReturnValue(new Promise(() => {}));

    renderDialog();

    expect(screen.getByText(/my-repo/)).toBeDefined();
  });

  it('非删除状态 ESC 可关闭弹框', () => {
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onOpenChange).toHaveBeenCalled();
    expect(onOpenChange.mock.calls[0][0]).toBe(false);
  });

  it('删除进行中 ESC 与取消按钮均不可关闭弹框', async () => {
    mockDeleteWorktree.mockReturnValue(new Promise(() => {}));
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(screen.getByText('删除中...')).toBeDefined());

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText('取消')).toBeDisabled();
  });

  it('success=false 且 error=null 时 toast 展示失败明细', async () => {
    mockResult({
      success: false,
      closedSessionIds: [],
      failures: [{ sessionId: 'sess-1', error: 'acp:stop 超时' }],
      error: null,
    });
    renderDialog();

    fireEvent.click(screen.getByText('确认删除'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const msg = vi.mocked(toast.error).mock.calls[0][0] as string;
    expect(msg).toContain('sess-1');
    expect(msg).toContain('acp:stop 超时');
  });

  it('success=true 但 failures 非空时按部分失败提示', async () => {
    mockResult({
      success: true,
      closedSessionIds: ['sess-1'],
      failures: [{ sessionId: 'sess-2', error: '目录删除失败' }],
      error: null,
    });
    renderDialog();

    fireEvent.click(screen.getByText('确认删除'));

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    const msg = vi.mocked(toast.warning).mock.calls[0][0] as string;
    expect(msg).toContain('sess-2');
    expect(msg).toContain('目录删除失败');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('删除成功且当前路由为被关闭会话页时跳转首页', async () => {
    mockPathname = '/sessions/sess-1';
    mockResult({ success: true, closedSessionIds: ['sess-1'], failures: [], error: null });
    renderDialog();

    fireEvent.click(screen.getByText('确认删除'));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('当前路由与被删 worktree 无关时不跳转', async () => {
    mockPathname = '/sessions/other';
    mockResult({ success: true, closedSessionIds: ['sess-1'], failures: [], error: null });
    renderDialog();

    fireEvent.click(screen.getByText('确认删除'));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
