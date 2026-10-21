import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NewSessionDialog from './NewSessionDialog';
import type { CloudHostData } from '../../graphql/types';

const mockUseQuery = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useLazyQuery: () => [vi.fn()],
}));

function makeCloudHost(overrides: Partial<CloudHostData> = {}): CloudHostData {
  return {
    id: 'cloud-1',
    name: '云电脑 A',
    controllerId: 'ctrl-cloud',
    status: 'RUNNING',
    harnessTypes: ['OPENCODE'],
    defaultSessionId: null,
    activeSessionCount: 0,
    failureReason: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('NewSessionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue({ data: undefined, loading: false });
  });

  it('预选择 worktree 模式下展示目标 worktree 路径', () => {
    render(
      <NewSessionDialog
        controllers={[{ id: 'ctrl-1', name: 'Controller 1', status: 'online' }]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        existingWorktreePath="/repo/.worktrees/feat-a"
        existingControllerId="ctrl-1"
        existingWorkspaceId="ws-1"
      />,
    );

    expect(screen.getByText('/repo/.worktrees/feat-a')).toBeDefined();
  });

  it('T-AW11 普通主机在线时可选', () => {
    render(
      <NewSessionDialog
        controllers={[{ id: 'ctrl-1', name: '本机', status: 'online', type: 'local' }]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.getByRole('option', { name: '本机' })).toBeInTheDocument();
  });

  it('云电脑 RUNNING 时可选', () => {
    render(
      <NewSessionDialog
        controllers={[
          {
            id: 'ctrl-cloud',
            name: '云电脑 A',
            status: 'online',
            type: 'cloud',
            cloudHost: makeCloudHost({ status: 'RUNNING' }),
          },
        ]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.getByRole('option', { name: '云电脑 A' })).toBeInTheDocument();
  });

  it.each(['STOPPED', 'FAILED', 'STARTING', 'STOPPING'] as const)(
    '预选云电脑 %s 时不可选并提示',
    (status) => {
      render(
        <NewSessionDialog
          controllers={[
            {
              id: 'ctrl-cloud',
              name: '云电脑 A',
              status: 'online',
              type: 'cloud',
              cloudHost: makeCloudHost({ status }),
            },
          ]}
          onClose={vi.fn()}
          onCreate={vi.fn()}
          existingControllerId="ctrl-cloud"
        />,
      );

      expect(screen.queryByRole('option', { name: '云电脑 A' })).not.toBeInTheDocument();
      expect(screen.getByTestId('cloud-host-unavailable-hint')).toHaveTextContent('该云电脑未运行，无法创建会话');
    },
  );

  it('预选云电脑终态时提示无法创建会话且提交禁用', () => {
    render(
      <NewSessionDialog
        controllers={[
          {
            id: 'ctrl-cloud',
            name: '云电脑 A',
            status: 'online',
            type: 'cloud',
            cloudHost: makeCloudHost({ status: 'STOPPED' }),
          },
        ]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        existingControllerId="ctrl-cloud"
      />,
    );

    expect(screen.getByTestId('cloud-host-unavailable-hint')).toHaveTextContent('该云电脑未运行，无法创建会话');
    expect(screen.getByRole('button', { name: '创建会话' })).toBeDisabled();
  });

  it('D-9 普通主机在线且存在未运行云电脑时不展示云电脑提示', () => {
    render(
      <NewSessionDialog
        controllers={[
          { id: 'ctrl-local', name: '本机', status: 'online', type: 'local' },
          {
            id: 'ctrl-cloud',
            name: '云电脑 A',
            status: 'offline',
            type: 'cloud',
            cloudHost: makeCloudHost({ status: 'STOPPED' }),
          },
        ]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.getByRole('option', { name: '本机' })).toBeInTheDocument();
    expect(screen.queryByTestId('cloud-host-unavailable-hint')).not.toBeInTheDocument();
  });

  it('D-9 已选中的云电脑变为未运行时展示提示', () => {
    const controllers = (status: 'RUNNING' | 'STOPPED') => [
      {
        id: 'ctrl-cloud',
        name: '云电脑 A',
        status: 'online',
        type: 'cloud',
        cloudHost: makeCloudHost({ status }),
      },
    ];

    const { rerender } = render(
      <NewSessionDialog
        controllers={controllers('RUNNING')}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('控制器'), { target: { value: 'ctrl-cloud' } });
    expect(screen.queryByTestId('cloud-host-unavailable-hint')).not.toBeInTheDocument();

    rerender(
      <NewSessionDialog
        controllers={controllers('STOPPED')}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.getByTestId('cloud-host-unavailable-hint')).toHaveTextContent('云电脑未运行，暂不可创建会话');
  });
});
