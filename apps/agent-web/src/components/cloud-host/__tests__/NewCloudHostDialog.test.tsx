import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewCloudHostDialog from '../NewCloudHostDialog';
import type { CloudHostCapabilitiesData, HarnessType } from '../../../graphql/types';
const mockCreateCloudHost = vi.fn();
const mockUseQuery = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: () => [mockCreateCloudHost],
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
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
      },
      loading: false,
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

  it('默认未勾选工作区时单 Harness 不提示自动创建会话，勾选后才提示', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '  云电脑 A  ' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));

    // 默认不建工作区：就绪后不会自动建会话，文案不得自相矛盾
    expect(screen.queryByText('将自动创建会话')).not.toBeInTheDocument();
    expect(screen.getByText('不会创建工作区，就绪后需先创建或绑定工作区')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('创建默认工作区'));
    expect(screen.getByText('将自动创建会话')).toBeInTheDocument();
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
        variables: { input: { name: '云电脑 A', harnessTypes: ['OPENCODE'], createDefaultWorkspace: false } },
      });
    });
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'cloud-1' }));
    });
  });

  it('T-AW-N1 默认不勾选创建默认工作区并提示不会创建工作区', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    const checkbox = screen.getByLabelText('创建默认工作区');
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText('不会创建工作区，就绪后需先创建或绑定工作区')).toBeInTheDocument();
  });

  it('T-AW-N2 勾选后提交 createDefaultWorkspace=true 并提示自动创建会话', async () => {
    const onCreated = vi.fn();
    render(<NewCloudHostDialog {...defaultProps} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(screen.getByLabelText('创建默认工作区'));

    expect(screen.getByText('将创建默认工作区并自动创建会话')).toBeInTheDocument();
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(mockCreateCloudHost).toHaveBeenCalledWith({
        variables: {
          input: {
            name: '云电脑 A',
            harnessTypes: ['OPENCODE'],
            createDefaultWorkspace: true,
          },
        },
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

  it('T-AW5 服务端 too many cloud hosts 映射为中文 1 实例上限提示', async () => {
    mockCreateCloudHost.mockRejectedValueOnce(new Error('too many cloud hosts'));

    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('每用户同时最多 1 个云电脑实例');
    expect(screen.getByRole('alert')).not.toHaveTextContent('too many cloud hosts');
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

  it('实例上限时禁用提交并提示', () => {
    render(<NewCloudHostDialog {...defaultProps} hasActiveCloudHost />);

    expect(screen.getByText('每用户同时最多 1 个云电脑实例')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
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
            createDefaultWorkspace: false,
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
        variables: { input: { name: '云电脑 A', harnessTypes: ['OPENCODE'], createDefaultWorkspace: false } },
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
