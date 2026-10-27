import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewCloudHostDialog from '../NewCloudHostDialog';
import { GET_GITHUB_ACCOUNTS } from '../../../graphql/queries';
import type { CloudHostCapabilitiesData, HarnessType } from '../../../graphql/types';
const mockCreateCloudHost = vi.fn();
const mockSetupGithubProject = vi.fn();
const mockUseQuery = vi.fn();
const mockRefetchQuote = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: (doc: unknown) =>
    JSON.stringify(doc).includes('setupCloudHostGithubProject')
      ? [mockSetupGithubProject]
      : [mockCreateCloudHost],
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock('../GithubSetupProgressDialog', () => ({
  default: ({
    open,
    hostId,
    operationId,
  }: {
    open: boolean;
    hostId?: string;
    operationId: string | null;
  }) =>
    open ? (
      <div
        data-testid="cloud-host-progress-dialog"
        data-host-id={hostId ?? ''}
        data-operation-id={operationId ?? ''}
      />
    ) : null,
}));

const defaultCapabilities: CloudHostCapabilitiesData = {
  enabled: true,
  supportedHarnesses: ['OPENCODE'],
};

const defaultProps = {
  open: true,
  capabilities: defaultCapabilities,
  onClose: vi.fn(),
  onCreated: vi.fn(),
};

function submitButton() {
  return screen.getByRole('button', { name: '创建云电脑' });
}

describe('NewCloudHostDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue({
      data: {
        cloudHostWorkloadCatalog: [
          {
            workloadId: 'wl-docker',
            name: 'Docker',
            workloadKind: 'STANDARD',
            paramSchema: [],
            dependsOnWorkloadIds: [],
            isPreset: false,
            installed: false,
          },
          {
            workloadId: 'wl-dotnet',
            name: '.NET',
            workloadKind: 'STANDARD',
            paramSchema: [],
            dependsOnWorkloadIds: [],
            isPreset: false,
            installed: false,
          },
          {
            workloadId: 'wl-aspire',
            name: 'Aspire',
            workloadKind: 'STANDARD',
            paramSchema: [],
            dependsOnWorkloadIds: ['wl-docker', 'wl-dotnet'],
            isPreset: false,
            installed: false,
          },
        ],
        cloudHostBillingQuote: {
          createCredits: 5,
          perMinuteCredits: 1,
          availableBalance: 20,
        },
      },
      loading: false,
      refetch: mockRefetchQuote,
    });
    mockCreateCloudHost.mockResolvedValue({
      data: {
        createCloudHost: {
          id: 'cloud-1',
          name: '云电脑 A',
          controllerId: 'ctrl-cloud',
          status: 'STARTING',
          harnessTypes: ['OPENCODE'],
          defaultSessionId: null,
          activeSessionCount: 0,
          failureReason: null,
          deletedAt: null,
        },
      },
    });
  });

  it('T-AW3 名称为空时禁用提交并提示', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.getByText('请输入云电脑名称')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('T-AW3 名称全空白视为空', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '   ' } });

    expect(screen.getByText('请输入云电脑名称')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('T-AW3 未选择 Harness 时禁用提交', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });

    expect(screen.getByText('请至少选择一种 Harness')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('不提供「创建默认工作区」勾选，单 Harness 提示就绪后不会自动创建会话', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '  云电脑 A  ' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));

    // 默认工作区只在「Git 项目设置」初始化时创建：普通创建不会自动建会话
    expect(screen.queryByLabelText('创建默认工作区')).not.toBeInTheDocument();
    expect(screen.queryByText('将自动创建会话')).not.toBeInTheDocument();
    expect(
      screen.getByText('就绪后不会自动创建会话，需先创建或绑定工作区'),
    ).toBeInTheDocument();
    expect(submitButton()).not.toBeDisabled();
  });

  it('T-AW4 提交成功使用 trim 后名称与 harnessTypes，并回调创建结果', async () => {
    const onCreated = vi.fn();
    render(<NewCloudHostDialog {...defaultProps} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '  云电脑 A  ' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(mockCreateCloudHost).toHaveBeenCalledWith({
        variables: { input: { name: '云电脑 A', harnessTypes: ['OPENCODE'] } },
      });
    });
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'cloud-1' }));
    });
  });

  it('多选 Harness 时提示不自动创建会话', () => {
    render(
      <NewCloudHostDialog
        {...defaultProps}
        capabilities={{ enabled: true, supportedHarnesses: ['OPENCODE', 'CLAUDE_CODE'] as HarnessType[] }}
      />,
    );

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(screen.getByLabelText('CLAUDE_CODE'));

    expect(screen.getByText('不自动创建会话')).toBeInTheDocument();
  });

  it('T-AW3 名称超过 64 字符时禁用提交并提示', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'a'.repeat(65) } });

    expect(screen.getByText('名称不能超过 64 个字符')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('T-AW5 服务端 insufficient balance 映射为余额不足提示', async () => {
    mockCreateCloudHost.mockRejectedValueOnce(new Error('insufficient balance'));

    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('账户余额不足，请联系管理员充值后重试');
    expect(mockRefetchQuote).toHaveBeenCalled();
  });

  it.each([
    'name is required',
    'name is too long',
    'harness feature is disabled',
    'at least one harness type is required',
    'unsupported harness type: x',
  ])('T-AW5 服务端错误「%s」原样展示', async (message) => {
    mockCreateCloudHost.mockRejectedValueOnce(new Error(message));

    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('T-AW16: 收费详情区块展示创建/运行/欠费提示', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.getByText('收费详情')).toBeInTheDocument();
    expect(
      screen.getByText('创建花费：5 credits（一次性，确认创建即扣费）'),
    ).toBeInTheDocument();
    expect(screen.getByText(/运行消费：1 credit\/分钟/)).toBeInTheDocument();
    expect(screen.getByText('余额不足持续 10 分钟云电脑将被强制销毁')).toBeInTheDocument();
  });

  it('T-AW17: 报价查询失败时降级提示且不阻断提交', () => {
    mockUseQuery.mockReturnValue({
      data: null,
      loading: false,
      error: new Error('quote down'),
    });

    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.getByText('创建与运行将产生费用，详见账单')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    expect(submitButton()).not.toBeDisabled();
  });

  it('T-AW18: 余额不足提示充值但不前置禁用提交', () => {
    mockUseQuery.mockReturnValue({
      data: {
        cloudHostWorkloadCatalog: [],
        cloudHostBillingQuote: {
          createCredits: 5,
          perMinuteCredits: 1,
          availableBalance: 1,
        },
      },
      loading: false,
    });

    render(<NewCloudHostDialog {...defaultProps} />);

    expect(
      screen.getByText('当前可用余额：1 credits，余额不足，请联系管理员充值'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    expect(submitButton()).not.toBeDisabled();
  });

  it('T-AW13 不出现存储/会话导入参数', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.queryByText(/存储会话/)).not.toBeInTheDocument();
    expect(screen.queryByText(/恢复的会话/)).not.toBeInTheDocument();
  });

  it('T-WEB-N1: 打开弹窗展示 Aspire/Docker/.NET 与依赖名称', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.getByLabelText('Docker')).toBeInTheDocument();
    expect(screen.getByLabelText('.NET')).toBeInTheDocument();
    expect(screen.getByLabelText('Aspire')).toBeInTheDocument();
    expect(screen.getByText('依赖：Docker、.NET')).toBeInTheDocument();
  });

  it('T-WEB-N2: 勾选 Docker 后提交携带 workloadIds 并提示耗时', async () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(screen.getByLabelText('Docker'));

    expect(screen.getByText('勾选运行环境负载会延长首次就绪时间')).toBeInTheDocument();

    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(mockCreateCloudHost).toHaveBeenCalledWith({
        variables: {
          input: {
            name: '云电脑 A',
            harnessTypes: ['OPENCODE'],
            workloadIds: ['wl-docker'],
          },
        },
      });
    });
  });

  it('T-WEB-N3: 不勾选负载时提交不含 workloadIds', async () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(mockCreateCloudHost).toHaveBeenCalledWith({
        variables: { input: { name: '云电脑 A', harnessTypes: ['OPENCODE'] } },
      });
    });
    expect(mockCreateCloudHost.mock.calls[0][0].variables.input).not.toHaveProperty('workloadIds');
  });

  it('T-WEB-N4: catalog 失败时提示但仍可提交基础创建', async () => {
    mockUseQuery.mockReturnValue({
      data: null,
      loading: false,
      error: new Error('boom'),
    });

    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.getByText('负载列表加载失败，可仅创建基础云电脑')).toBeInTheDocument();
    expect(screen.queryByLabelText('Docker')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    expect(submitButton()).not.toBeDisabled();
  });

  it.each([
    ['too many workloads (max 5)', '创建时最多选择 5 个工作负载'],
    ['invalid workload: wl-x', '所选工作负载不存在或不可用'],
    ['workload is not installable: OpenCode', '该工作负载不支持创建时预装'],
    ['invalid workload parameter: mode', '工作负载参数默认值非法，无法创建'],
    ['dependency workload not found: ghost', '工作负载依赖缺失，无法创建'],
    ['dependency cycle detected', '工作负载依赖成环，无法创建'],
    ['dependency cycle detected: a -> b -> a', '工作负载依赖成环，无法创建'],
  ])('T-WEB-N5: 服务端错误「%s」映射为中文', async (message, expected) => {
    mockCreateCloudHost.mockRejectedValueOnce(new Error(message));

    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
  });
});

function mockGithubProjectQueries(accounts: unknown[] = [githubAccount()]) {
  mockUseQuery.mockImplementation((query: unknown) => {
    if (query === GET_GITHUB_ACCOUNTS) {
      return { data: { githubAccounts: accounts }, loading: false };
    }
    return {
      data: {
        cloudHostWorkloadCatalog: [
          {
            workloadId: 'wl-docker',
            name: 'Docker',
            workloadKind: 'STANDARD',
            paramSchema: [],
            dependsOnWorkloadIds: [],
            isPreset: false,
            installed: false,
          },
        ],
      },
      loading: false,
    };
  });
}

function githubAccount() {
  return {
    id: 'acc-1',
    githubUserId: 1,
    githubLogin: 'alice',
    createdAt: '',
    installations: [
      {
        id: 'inst-1',
        installationId: 10,
        managementUrl: '',
        createdAt: '',
        repos: [
          {
            id: 'repo-1',
            repoId: 1,
            repoName: 'repo-a',
            fullName: 'alice/repo-a',
            private: false,
            permissions: { read: true, write: true },
          },
        ],
      },
    ],
  };
}

describe('NewCloudHostDialog Github 项目编排', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateCloudHost.mockResolvedValue({
      data: {
        createCloudHost: {
          id: 'cloud-1',
          name: '云电脑 A',
          controllerId: 'ctrl-cloud',
          status: 'STARTING',
          harnessTypes: ['OPENCODE'],
          defaultSessionId: null,
          activeSessionCount: 0,
          failureReason: null,
          deletedAt: null,
        },
      },
    });
    mockGithubProjectQueries();
  });

  it('未绑定账号时提示且禁用提交', () => {
    mockGithubProjectQueries([]);
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(screen.getByLabelText('配置 Github 项目'));

    expect(screen.getByText('尚未绑定 Github 帐号，请前往设置页绑定')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('选择项目后提交 createDefaultSession=false 并进入启动进度框', async () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(screen.getByLabelText('配置 Github 项目'));

    await waitFor(() => expect(screen.getByLabelText('Github 账号')).toHaveValue('acc-1'));
    const prefixInput = screen.getByLabelText('前缀地址');
    expect(prefixInput).toHaveValue('~/workspace');
    expect(prefixInput).toHaveAttribute('placeholder', '~/workspace');
    fireEvent.change(screen.getByLabelText('仓库'), { target: { value: 'alice/repo-a' } });
    expect(screen.getByText('最终 clone 地址：/home/worker/workspace/alice/repo-a')).toBeInTheDocument();

    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(mockCreateCloudHost).toHaveBeenCalledWith({
        variables: {
          input: {
            name: '云电脑 A',
            harnessTypes: ['OPENCODE'],
            githubAccountId: 'acc-1',
            createDefaultSession: false,
          },
        },
      });
    });
    const progress = await screen.findByTestId('cloud-host-progress-dialog');
    expect(progress).toHaveAttribute('data-host-id', 'cloud-1');
    expect(progress).toHaveAttribute('data-operation-id', '');
  });

  it('项目已选但仓库为空时禁用提交', async () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(screen.getByLabelText('配置 Github 项目'));

    await screen.findByLabelText('Github 账号');
    expect(submitButton()).toBeDisabled();
  });

  it('T-E-HL7 supportedHarnesses 含 KIMI_CODE 时展示 Kimi Code 并可多选', () => {
    render(
      <NewCloudHostDialog
        {...defaultProps}
        capabilities={{ enabled: true, supportedHarnesses: ['OPENCODE', 'KIMI_CODE'] }}
      />,
    );

    expect(screen.getByLabelText('OpenCode')).toBeInTheDocument();
    const kimi = screen.getByLabelText('Kimi Code');
    expect(kimi).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Kimi 云电脑' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(kimi);

    expect(screen.getByText('不自动创建会话')).toBeInTheDocument();
    expect(submitButton()).not.toBeDisabled();
  });

  it('T-E-DS1 supportedHarnesses 含 DEEPSEEK_HARNESS 时展示 DeepSeek Harness 并可多选', () => {
    render(
      <NewCloudHostDialog
        {...defaultProps}
        capabilities={{ enabled: true, supportedHarnesses: ['OPENCODE', 'KIMI_CODE', 'DEEPSEEK_HARNESS'] }}
      />,
    );

    expect(screen.getByLabelText('OpenCode')).toBeInTheDocument();
    expect(screen.getByLabelText('Kimi Code')).toBeInTheDocument();
    const deepseek = screen.getByLabelText('DeepSeek Harness');
    expect(deepseek).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'DeepSeek 云电脑' } });
    fireEvent.click(deepseek);
    fireEvent.click(screen.getByLabelText('OpenCode'));
    expect(screen.getByText('不自动创建会话')).toBeInTheDocument();
    expect(submitButton()).not.toBeDisabled();

    expect(screen.getByLabelText('DeepSeek Harness')).toBeChecked();
    expect(screen.getByLabelText('OpenCode')).toBeChecked();
  });
});
