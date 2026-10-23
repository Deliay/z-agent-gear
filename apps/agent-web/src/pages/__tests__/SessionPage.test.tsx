import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SessionPage from '../SessionPage';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  navigate: vi.fn(),
  dialogProps: null as null | Record<string, unknown>,
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: () => ({ data: { controllers: [] }, loading: false, error: undefined }),
  useMutation: () => [mocks.createSession],
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({}),
  useNavigate: () => mocks.navigate,
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('../../components/session/NewSessionDialog', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.dialogProps = props;
    return null;
  },
}));

vi.mock('../../components/session/SessionView', () => ({ default: () => null }));

describe('SessionPage 新建会话参数映射', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue({
      data: { createSession: { session: { id: 'sess-new' } } },
    });
  });

  it('R-1: 9 个位置参数按序映射到 CreateSessionInput（modeId/modelId 不错位）', async () => {
    render(<SessionPage />);
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));

    const props = mocks.dialogProps as {
      onCreate: (...args: unknown[]) => Promise<void>;
    };
    expect(props).toBeTruthy();

    await props.onCreate(
      'ctrl-1',
      'opencode',
      'ws-1',
      false,
      'feat-x',
      ['mcp-1'],
      '/repo/.worktrees/feat-a',
      'mode-1',
      'model-1',
    );

    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1));
    expect(mocks.createSession.mock.calls[0][0]).toEqual({
      variables: {
        input: {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
          enableWorktree: false,
          worktreeBranchSuffix: 'feat-x',
          mcpServerIds: ['mcp-1'],
          existingWorktreePath: '/repo/.worktrees/feat-a',
          modeId: 'mode-1',
          modelId: 'model-1',
        },
      },
      refetchQueries: expect.any(Array),
    });
    expect(mocks.navigate).toHaveBeenCalledWith('/sessions/sess-new');
  });

  it('R-1: 未传可选参数时 modeId/modelId/existingWorktreePath 落 null，mcpServerIds 走控制器默认', async () => {
    render(<SessionPage />);
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
    const props = mocks.dialogProps as {
      onCreate: (...args: unknown[]) => Promise<void>;
    };

    await props.onCreate('ctrl-1', 'opencode', 'ws-1');

    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1));
    expect(mocks.createSession.mock.calls[0][0].variables.input).toMatchObject({
      existingWorktreePath: null,
      modeId: null,
      modelId: null,
      mcpServerIds: null,
    });
  });
});
