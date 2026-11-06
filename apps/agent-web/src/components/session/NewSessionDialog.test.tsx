import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewSessionDialog from './NewSessionDialog';
import {
  GET_ACP_CAPABILITIES,
  GET_ACP_SERVER_OPTIONS,
  GET_CONTROLLER_WORKSPACES_ENABLED,
  GET_MCP_SERVERS,
  GET_CUSTOM_MCP_SERVERS,
} from '../../graphql/queries';
import type { CloudHostData, ControllerWorkspaceData, CustomMcpServerData } from '../../graphql/types';

const mockUseQuery = vi.fn();
const mockRefreshOptions = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useLazyQuery: () => [vi.fn().mockResolvedValue({ data: { detectGitRepo: { isGitRepo: false } } })],
  useMutation: () => [mockRefreshOptions, { loading: false }],
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

function makeWorkspace(overrides: Partial<ControllerWorkspaceData> = {}): ControllerWorkspaceData {
  return {
    id: 'ws-1',
    userId: 'u-1',
    controllerId: 'ctrl-1',
    name: '主工作区',
    path: '/repo',
    isEnabled: true,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

interface MockDialogOptions {
  mcpServers?: Array<{ id: string; name: string; enabled: boolean }>;
  customMcpServers?: CustomMcpServerData[];
  workspaces?: ControllerWorkspaceData[];
  options?: {
    modes: Array<{ id: string; name: string }>;
    models: Array<{ id: string; name: string }>;
  };
  refetchWorkspaces?: ReturnType<typeof vi.fn>;
}

function mockDialogQueries({
  mcpServers = [],
  customMcpServers = [],
  workspaces = [makeWorkspace()],
  options,
  refetchWorkspaces = vi.fn().mockResolvedValue(undefined),
}: MockDialogOptions = {}) {
  mockUseQuery.mockImplementation((query: unknown) => {
    if (query === GET_ACP_CAPABILITIES) {
      return { data: { acpCapabilities: [{ type: 'opencode', available: true }] }, loading: false };
    }
    if (query === GET_CONTROLLER_WORKSPACES_ENABLED) {
      return {
        data: { controllerWorkspaces: workspaces },
        loading: false,
        refetch: refetchWorkspaces,
      };
    }
    if (query === GET_MCP_SERVERS) {
      return {
        data: {
          mcpServers: mcpServers.map((server) => ({
            transport: 'stdio',
            source: 'manual',
            status: 'active',
            ...server,
          })),
        },
        loading: false,
      };
    }
    if (query === GET_CUSTOM_MCP_SERVERS) {
      return { data: { customMcpServers }, loading: false };
    }
    if (query === GET_ACP_SERVER_OPTIONS) {
      return {
        data: options
          ? { acpServerOptions: { ...options, currentModeId: null, currentModelId: null, probedAt: null } }
          : undefined,
        loading: false,
      };
    }
    return { data: undefined, loading: false };
  });
  return { refetchWorkspaces };
}

async function renderSessionDialog(
  onCreate = vi.fn(),
  controllers: Array<{
    id: string
    name: string
    status: string
    defaultMcp?: { useAllEnabled: boolean; serverIds: string[] } | null
  }> = [{ id: 'ctrl-1', name: 'Controller 1', status: 'online' }],
) {
  render(
    <NewSessionDialog controllers={controllers} onClose={vi.fn()} onCreate={onCreate} />,
  );
  fireEvent.change(screen.getByLabelText('控制器'), {
    target: { value: controllers[0]?.id ?? 'ctrl-1' },
  });
  await waitFor(() => expect(screen.getByRole('button', { name: '创建会话' })).not.toBeDisabled());
  return onCreate;
}

describe('NewSessionDialog 默认 MCP 与模型/模式', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('打开时按控制器默认（useAllEnabled）预选全部已启用 MCP', () => {
    mockDialogQueries({
      mcpServers: [
        { id: 'm1', name: 'MCP A', enabled: true },
        { id: 'm2', name: 'MCP B', enabled: true },
        { id: 'm3', name: 'MCP Off', enabled: false },
      ],
    });
    render(
      <NewSessionDialog
        controllers={[{ id: 'ctrl-1', name: 'Controller 1', status: 'online', defaultMcp: { useAllEnabled: true, serverIds: [] } }]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('控制器'), { target: { value: 'ctrl-1' } });

    expect(screen.getByLabelText('MCP A')).toBeChecked();
    expect(screen.getByLabelText('MCP B')).toBeChecked();
    expect(screen.queryByLabelText('MCP Off')).not.toBeInTheDocument();
    // U-5：钉死新文案，且旧文案「新 MCP 上线后自动注入」回退时必须变红
    expect(screen.getByText(/默认注入全部已启用的 MCP；可取消勾选/)).toBeInTheDocument();
    expect(screen.queryByText(/新 MCP 上线后自动注入/)).not.toBeInTheDocument();
  });

  it('按控制器 serverIds 交集预选（useAllEnabled=false）', () => {
    mockDialogQueries({
      mcpServers: [
        { id: 'm1', name: 'MCP A', enabled: true },
        { id: 'm2', name: 'MCP B', enabled: true },
      ],
    });
    render(
      <NewSessionDialog
        controllers={[{ id: 'ctrl-1', name: 'Controller 1', status: 'online', defaultMcp: { useAllEnabled: false, serverIds: ['m2', 'gone'] } }]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('控制器'), { target: { value: 'ctrl-1' } });

    expect(screen.getByLabelText('MCP A')).not.toBeChecked();
    expect(screen.getByLabelText('MCP B')).toBeChecked();
  });

  it('用户手动调整后，后台控制器数据刷新不覆盖选择', () => {
    mockDialogQueries({
      mcpServers: [
        { id: 'm1', name: 'MCP A', enabled: true },
        { id: 'm2', name: 'MCP B', enabled: true },
      ],
    });
    const controllers = [{ id: 'ctrl-1', name: 'Controller 1', status: 'online' }];
    const { rerender } = render(
      <NewSessionDialog controllers={controllers} onClose={vi.fn()} onCreate={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('控制器'), { target: { value: 'ctrl-1' } });
    fireEvent.click(screen.getByLabelText('MCP A'));
    expect(screen.getByLabelText('MCP A')).not.toBeChecked();

    // 模拟 HOME_OVERVIEW 轮询产生新的 controllers 数组
    rerender(
      <NewSessionDialog
        controllers={[...controllers]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('MCP A')).not.toBeChecked();
    expect(screen.getByLabelText('MCP B')).toBeChecked();
  });

  it('提交时显式传空数组表示不注入 MCP，modeId/modelId 未选则不传', async () => {
    mockDialogQueries({
      mcpServers: [
        { id: 'm1', name: 'MCP A', enabled: true },
        { id: 'm2', name: 'MCP B', enabled: true },
      ],
    });
    const onCreate = await renderSessionDialog();

    // 默认全选后全部取消
    fireEvent.click(screen.getByLabelText('MCP A'));
    fireEvent.click(screen.getByLabelText('MCP B'));
    fireEvent.click(screen.getByRole('button', { name: '创建会话' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const args = onCreate.mock.calls[0];
    expect(args[5]).toEqual([]);
    expect(args[7]).toBeUndefined();
    expect(args[8]).toBeUndefined();
  });

  it('选择模式/模型后透传到 onCreate', async () => {
    mockDialogQueries({
      options: {
        modes: [{ id: 'mode-fast', name: '快速' }],
        models: [{ id: 'model-a', name: 'Model A' }],
      },
    });
    const onCreate = await renderSessionDialog();

    fireEvent.click(screen.getByRole('combobox', { name: '模式' }));
    const modeOption = await screen.findByRole('option', { name: '快速' });
    fireEvent.pointerDown(modeOption, { pointerType: 'mouse' });
    fireEvent.click(modeOption);
    fireEvent.click(screen.getByRole('combobox', { name: '模型' }));
    const modelOption = await screen.findByRole('option', { name: 'Model A' });
    fireEvent.pointerDown(modelOption, { pointerType: 'mouse' });
    fireEvent.click(modelOption);
    fireEvent.click(screen.getByRole('button', { name: '创建会话' }));

    const args = onCreate.mock.calls[0];
    expect(args[7]).toBe('mode-fast');
    expect(args[8]).toBe('model-a');
  });

  it('点击「刷新」调用 refreshAcpServerOptions 并替换选项', async () => {
    mockDialogQueries({ options: { modes: [{ id: 'mode-old', name: '旧模式' }], models: [] } });
    mockRefreshOptions.mockResolvedValue({
      data: {
        refreshAcpServerOptions: {
          modes: [{ id: 'mode-new', name: '新模式' }],
          models: [],
          currentModeId: null,
          currentModelId: null,
          probedAt: null,
        },
      },
    });
    render(
      <NewSessionDialog
        controllers={[{ id: 'ctrl-1', name: 'Controller 1', status: 'online' }]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('控制器'), { target: { value: 'ctrl-1' } });
    await waitFor(() => expect(screen.getByRole('combobox', { name: '模式' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));

    await waitFor(() => {
      expect(mockRefreshOptions).toHaveBeenCalledWith({
        variables: { controllerId: 'ctrl-1', acpServerType: 'opencode' },
      });
    });
    fireEvent.click(screen.getByRole('combobox', { name: '模式' }));
    expect(await screen.findByRole('option', { name: '新模式' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '旧模式' })).not.toBeInTheDocument();
  });

  it('打开时刷新工作区列表（Git 设置新增工作区随即可见）', async () => {
    const { refetchWorkspaces } = mockDialogQueries();
    render(
      <NewSessionDialog
        controllers={[{ id: 'ctrl-1', name: 'Controller 1', status: 'online' }]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('控制器'), { target: { value: 'ctrl-1' } });

    await waitFor(() => expect(refetchWorkspaces).toHaveBeenCalled());
  });
});

function makeCustomMcp(id: string, name: string, endpoint: string): CustomMcpServerData {
  return {
    id,
    name,
    description: null,
    endpoint,
    authType: 'none',
    customHeaders: [],
    bearerEntryId: null,
    bearerEntryManaged: null,
    workspaceId: 'ws-1',
    createdBy: 'alice',
    createdAt: '',
    updatedAt: '',
  };
}

// T-WEB4 / D9：MCP 两组展示、勾选独立、onCreate 第 10 参
describe('NewSessionDialog 自定义 MCP 分组（D9）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('「MCP 服务」与「自定义 MCP（工作区）」两组分别展示，自定义组缺省不勾选', () => {
    mockDialogQueries({
      mcpServers: [{ id: 'm1', name: 'MCP A', enabled: true }],
      customMcpServers: [
        makeCustomMcp('cmcp-1', '内部文档 MCP', 'https://doc.example.com/mcp'),
        makeCustomMcp('cmcp-2', '内部聊天 MCP', 'https://chat.example.com/mcp'),
      ],
    });
    render(
      <NewSessionDialog
        controllers={[{ id: 'ctrl-1', name: 'Controller 1', status: 'online' }]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('控制器'), { target: { value: 'ctrl-1' } });

    expect(screen.getByText('MCP 服务')).toBeInTheDocument();
    expect(screen.getByText('自定义 MCP（工作区）')).toBeInTheDocument();
    // 既有个人级 MCP 过滤口径（enabled && name !== agent-cloud-host-tools）不变
    expect(screen.getByLabelText('MCP A')).toBeChecked();
    // 自定义组无「控制器默认注入」语义，缺省不勾选
    expect(screen.getByLabelText(/内部文档 MCP/)).not.toBeChecked();
    expect(screen.getByLabelText(/内部聊天 MCP/)).not.toBeChecked();
  });

  it('两组勾选独立，提交时第 10 参携带勾选的自定义 MCP id', async () => {
    mockDialogQueries({
      mcpServers: [{ id: 'm1', name: 'MCP A', enabled: true }],
      customMcpServers: [
        makeCustomMcp('cmcp-1', '内部文档 MCP', 'https://doc.example.com/mcp'),
        makeCustomMcp('cmcp-2', '内部聊天 MCP', 'https://chat.example.com/mcp'),
      ],
    });
    const onCreate = await renderSessionDialog();

    // 取消个人级 MCP、勾选一个自定义 MCP：互不影响
    fireEvent.click(screen.getByLabelText('MCP A'));
    fireEvent.click(screen.getByLabelText(/内部文档 MCP/));

    expect(screen.getByLabelText('MCP A')).not.toBeChecked();
    expect(screen.getByLabelText(/内部文档 MCP/)).toBeChecked();
    expect(screen.getByLabelText(/内部聊天 MCP/)).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '创建会话' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const args = onCreate.mock.calls[0];
    expect(args[5]).toEqual([]);
    expect(args[9]).toEqual(['cmcp-1']);
  });

  it('未勾选自定义 MCP 时第 10 参为 undefined（保持旧报文形状）', async () => {
    mockDialogQueries({
      mcpServers: [{ id: 'm1', name: 'MCP A', enabled: true }],
      customMcpServers: [makeCustomMcp('cmcp-1', '内部文档 MCP', 'https://doc.example.com/mcp')],
    });
    const onCreate = await renderSessionDialog();

    fireEvent.click(screen.getByRole('button', { name: '创建会话' }));

    const args = onCreate.mock.calls[0];
    expect(args[9]).toBeUndefined();
  });

  it('自定义 MCP 为空时展示「暂无自定义 MCP」', () => {
    mockDialogQueries({ customMcpServers: [] });
    render(
      <NewSessionDialog
        controllers={[{ id: 'ctrl-1', name: 'Controller 1', status: 'online' }]}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('控制器'), { target: { value: 'ctrl-1' } });

    expect(screen.getByText('暂无自定义 MCP')).toBeInTheDocument();
  });
});
