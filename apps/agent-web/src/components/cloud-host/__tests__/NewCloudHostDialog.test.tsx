import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewCloudHostDialog from '../NewCloudHostDialog';
import {
  CLOUD_HOST_SPECS,
  CLOUD_HOST_SPEC_BILLING_QUOTE,
  CLOUD_STORAGE_BILLING_QUOTE,
  CLOUD_STORAGE_CAPABILITIES,
  CLOUD_STORAGES,
  GET_GITHUB_ACCOUNTS,
} from '../../../graphql/queries';
import type {
  CloudHostCapabilitiesData,
  CloudHostSpecData,
  CloudHostSpecQuoteTierData,
  CloudStorageData,
  HarnessType,
} from '../../../graphql/types';
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

vi.mock('@/components/settings/NewCloudStorageDialog', () => ({
  default: ({
    open,
    onCreated,
  }: {
    open: boolean;
    onCreated?: (storage: CloudStorageData) => void;
  }) =>
    open ? (
      <div data-testid="new-cloud-storage-dialog">
        <button
          type="button"
          onClick={() =>
            onCreated?.({
              id: 'st-new',
              name: '新建存储',
              sizeGi: 10,
              status: 'IDLE',
              usageBytes: 0,
              usageUpdatedAt: null,
              hourlyCredits: 5,
              hourlyCreditsFull: 5,
              hourlyCreditsArchived: 2.5,
              createdBy: { id: 'u-1', name: 'alice' },
              createdAt: '2026-11-02T10:00:00.000Z',
              attachedCloudHostId: null,
              attachedCloudHostName: null,
              attachedAt: null,
              currentArchive: null,
              archiveSpace: { capacityGi: 100, usedGi: null },
              failureReason: null,
              destroyedAt: null,
            } as CloudStorageData)
          }
        >
          完成新建存储
        </button>
      </div>
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

const defaultCatalog = [
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
];

const defaultSpecs: CloudHostSpecData[] = [
  {
    id: 'spec-8c',
    name: '8C 16G 20G',
    cpu: 8,
    memoryGi: 16,
    ephemeralStorageGi: 20,
    unlimited: false,
    isPreset: true,
    hourlyCredits: 820,
  },
  {
    id: 'spec-2c',
    name: '2C 4G 10G',
    cpu: 2,
    memoryGi: 4,
    ephemeralStorageGi: 10,
    unlimited: false,
    isPreset: true,
    hourlyCredits: 90,
  },
];

const unlimitedSpec: CloudHostSpecData = {
  id: 'spec-0c',
  name: '0C 0G 0G',
  cpu: 0,
  memoryGi: 0,
  ephemeralStorageGi: 0,
  unlimited: true,
  isPreset: false,
  hourlyCredits: 0,
};

const defaultTiers: CloudHostSpecQuoteTierData[] = [
  { label: 'CPU 8 核 × 15 credits/核/小时', amountCredits: 120 },
  { label: '内存 16 GiB × 30 credits/GiB/小时', amountCredits: 540 },
  { label: '临时存储 10 GiB × 10 credits/GiB/小时', amountCredits: 100 },
];

function specQuoteFor(specId: string) {
  if (specId === 'spec-8c') {
    return { hourlyCredits: 820, tiers: defaultTiers, availableBalance: 20 };
  }
  if (specId === 'spec-2c') {
    return {
      hourlyCredits: 90,
      tiers: [{ label: 'CPU 2 核 × 15 credits/核/小时', amountCredits: 30 }],
      availableBalance: 20,
    };
  }
  return { hourlyCredits: 0, tiers: [], availableBalance: 20 };
}

interface QueryOverrides {
  /** null = 查询失败 */
  specs?: CloudHostSpecData[] | null;
  workloadCatalog?: unknown[];
  storages?: CloudStorageData[];
  storageEnabled?: boolean;
  /** null = 未绑定任何 Github 帐号 */
  githubAccounts?: unknown[] | null;
  storageQuoteHourly?: number;
  createCredits?: number;
  availableBalance?: number | null;
  /** 一次性创建费报价查询失败 */
  hostQuoteError?: boolean;
}

/** 按查询文档分派 Apollo mock，覆盖对话框全部 useQuery */
function installQueryMocks(overrides: QueryOverrides = {}) {
  const specs = overrides.specs === undefined ? defaultSpecs : overrides.specs;
  const catalog = overrides.workloadCatalog ?? defaultCatalog;
  mockUseQuery.mockImplementation(
    (query: unknown, options?: { variables?: Record<string, unknown> }) => {
      if (query === CLOUD_HOST_SPECS) {
        if (specs === null) {
          return { data: null, loading: false, error: new Error('specs down') };
        }
        return { data: { cloudHostSpecs: specs }, loading: false, error: null };
      }
      if (query === CLOUD_HOST_SPEC_BILLING_QUOTE) {
        const specId = String(options?.variables?.specId ?? '');
        return {
          data: { cloudHostSpecBillingQuote: specQuoteFor(specId) },
          loading: false,
          error: null,
        };
      }
      if (query === CLOUD_STORAGE_BILLING_QUOTE) {
        const sizeGi = Number(options?.variables?.sizeGi ?? 0);
        const hourlyCredits = overrides.storageQuoteHourly ?? 15;
        return {
          data: {
            cloudStorageBillingQuote: {
              sizeGi,
              full: { hourlyCredits, tiers: [] },
              archived: { hourlyCredits: hourlyCredits / 2, tiers: [] },
              availableBalance: 20,
            },
          },
          loading: false,
          error: null,
        };
      }
      if (query === CLOUD_STORAGE_CAPABILITIES) {
        return {
          data: { cloudStorageCapabilities: { enabled: overrides.storageEnabled === true } },
          loading: false,
          error: null,
        };
      }
      if (query === CLOUD_STORAGES) {
        const storages = overrides.storages ?? [];
        return {
          data: { cloudStorages: storages },
          loading: false,
          error: null,
          refetch: vi.fn().mockResolvedValue({ data: { cloudStorages: storages } }),
        };
      }
      if (query === GET_GITHUB_ACCOUNTS) {
        const accounts = overrides.githubAccounts === undefined ? [] : overrides.githubAccounts;
        if (accounts === null) {
          return { data: { githubAccounts: [] }, loading: false, error: null };
        }
        return { data: { githubAccounts: accounts }, loading: false, error: null };
      }
      if (overrides.hostQuoteError) {
        return {
          data: null,
          loading: false,
          error: new Error('quote down'),
          refetch: mockRefetchQuote,
        };
      }
      return {
        data: {
          cloudHostWorkloadCatalog: catalog,
          cloudHostBillingQuote: {
            createCredits: overrides.createCredits ?? 5,
            perMinuteCredits: 1,
            availableBalance: overrides.availableBalance === undefined ? 20 : overrides.availableBalance,
          },
        },
        loading: false,
        error: null,
        refetch: mockRefetchQuote,
      };
    },
  );
}

function submitButton() {
  return screen.getByRole('button', { name: '创建云电脑' });
}

function mockCreatedHost() {
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
}

describe('NewCloudHostDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installQueryMocks();
    mockCreatedHost();
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

  it('T-WEB3 未选择 Harness 也可提交（0 个 harness）+ 补装提示', async () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });

    // 不再有「请至少选择一种 Harness」拦截
    expect(screen.queryByText('请至少选择一种 Harness')).not.toBeInTheDocument();
    expect(screen.getByText('可不选，之后在设置-工作负载中补装')).toBeInTheDocument();
    expect(submitButton()).not.toBeDisabled();

    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(mockCreateCloudHost).toHaveBeenCalledWith({
        variables: { input: { name: '云电脑 A', harnessTypes: [], specId: 'spec-8c' } },
      });
    });
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
        variables: {
          input: { name: '云电脑 A', harnessTypes: ['OPENCODE'], specId: 'spec-8c' },
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
    'cloud host is not configured',
    'unsupported harness type: x',
  ])('T-AW5 服务端错误「%s」原样展示', async (message) => {
    mockCreateCloudHost.mockRejectedValueOnce(new Error(message));

    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('T-AW16: 收费详情区块展示一次性创建费用与每小时运行费用（不再展示每分钟）', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.getByText('收费详情')).toBeInTheDocument();
    expect(
      screen.getByText('创建花费：5 credits（一次性，确认创建即扣费）'),
    ).toBeInTheDocument();
    expect(screen.getByText('运行费用：820 credits/小时（按小时结算）')).toBeInTheDocument();
    expect(
      screen.getByText('CPU 8 核 × 15 credits/核/小时：120 credits/小时'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('cloud-host-hourly-total')).toHaveTextContent(
      '合计运行费用：820 credits/小时',
    );
    expect(screen.queryByText(/credit\/分钟/)).not.toBeInTheDocument();
    expect(screen.getByText('余额不足持续 10 分钟云电脑将被强制销毁')).toBeInTheDocument();
  });

  it('T-AW17: 报价查询失败时降级提示且不阻断提交', () => {
    installQueryMocks({ hostQuoteError: true });

    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.getByText('创建与运行将产生费用，详见账单')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    expect(submitButton()).not.toBeDisabled();
  });

  it('T-AW18: 余额不足提示充值但不前置禁用提交', () => {
    installQueryMocks({ availableBalance: 1 });

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
            specId: 'spec-8c',
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
        variables: {
          input: { name: '云电脑 A', harnessTypes: ['OPENCODE'], specId: 'spec-8c' },
        },
      });
    });
    expect(mockCreateCloudHost.mock.calls[0][0].variables.input).not.toHaveProperty('workloadIds');
  });

  it('T-WEB-N4: catalog 失败时提示但仍可提交基础创建', async () => {
    installQueryMocks({ workloadCatalog: [] });

    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.queryByLabelText('Docker')).not.toBeInTheDocument();
    expect(screen.getByText('暂无可预装工作负载')).toBeInTheDocument();

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

describe('NewCloudHostDialog 规格选择与总价', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatedHost();
  });

  it('T-SPEC1: 渲染规格列表并默认选中第一款为资源明细与每小时费用', () => {
    installQueryMocks();
    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.getByText('规格')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '8C 16G 20G' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '2C 4G 10G' })).not.toBeChecked();
    expect(
      screen.getByText('CPU 8 核 · 内存 16 GiB · 临时存储 20 GiB'),
    ).toBeInTheDocument();
    expect(screen.getByText('CPU 2 核 · 内存 4 GiB · 临时存储 10 GiB')).toBeInTheDocument();
    expect(screen.getByText('820 credits/小时')).toBeInTheDocument();
    expect(screen.getByText('90 credits/小时')).toBeInTheDocument();
    expect(screen.getAllByText('预制')).toHaveLength(2);
  });

  it('T-SPEC2: 0C 0G 不限制规格展示风险文案与 0 费用', () => {
    installQueryMocks({ specs: [unlimitedSpec] });
    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.getByRole('radio', { name: '0C 0G 0G' })).toBeChecked();
    expect(
      screen.getByText('不限制容器，随时可能会被系统销毁'),
    ).toBeInTheDocument();
    expect(screen.getByText('0 credits/小时')).toBeInTheDocument();
    expect(screen.getByText('运行费用：0 credits/小时（按小时结算）')).toBeInTheDocument();
    expect(screen.getByTestId('cloud-host-hourly-total')).toHaveTextContent(
      '合计运行费用：0 credits/小时',
    );
  });

  it('T-SPEC3: 默认按首款规格报价，切换规格后重新调用报价并刷新分档明细', () => {
    installQueryMocks();
    render(<NewCloudHostDialog {...defaultProps} />);

    const firstCalls = mockUseQuery.mock.calls.filter(
      ([query]) => query === CLOUD_HOST_SPEC_BILLING_QUOTE,
    );
    expect(firstCalls.at(-1)?.[1]).toMatchObject({ variables: { specId: 'spec-8c' } });

    fireEvent.click(screen.getByRole('radio', { name: '2C 4G 10G' }));

    const calls = mockUseQuery.mock.calls.filter(
      ([query]) => query === CLOUD_HOST_SPEC_BILLING_QUOTE,
    );
    expect(calls.at(-1)?.[1]).toMatchObject({ variables: { specId: 'spec-2c' } });
    expect(screen.getByText('运行费用：90 credits/小时（按小时结算）')).toBeInTheDocument();
    expect(screen.getByText('CPU 2 核 × 15 credits/核/小时：30 credits/小时')).toBeInTheDocument();
    expect(screen.getByTestId('cloud-host-hourly-total')).toHaveTextContent(
      '合计运行费用：90 credits/小时',
    );
  });

  it('T-SPEC4: 无可用规格时提示并禁用创建', () => {
    installQueryMocks({ specs: [] });
    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.getByText('暂无可用规格，请联系管理员')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    expect(submitButton()).toBeDisabled();
  });

  it('T-SPEC5: 规格列表查询失败时同样提示并禁用创建', () => {
    installQueryMocks({ specs: null });
    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.getByText('暂无可用规格，请联系管理员')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    expect(submitButton()).toBeDisabled();
  });

  it('T-SPEC6: 提交携带所选 specId', async () => {
    installQueryMocks();
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByRole('radio', { name: '2C 4G 10G' }));
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(mockCreateCloudHost).toHaveBeenCalledWith({
        variables: { input: { name: '云电脑 A', harnessTypes: [], specId: 'spec-2c' } },
      });
    });
  });
});

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
    mockCreatedHost();
    installQueryMocks({ githubAccounts: [githubAccount()] });
  });

  it('未绑定账号时提示且禁用提交', () => {
    installQueryMocks({ githubAccounts: [] });
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
            specId: 'spec-8c',
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

function makeStorage(overrides: Partial<CloudStorageData> = {}): CloudStorageData {
  return {
    id: 'st-idle',
    name: '待挂载存储',
    sizeGi: 20,
    status: 'IDLE',
    usageBytes: 0,
    usageUpdatedAt: null,
    hourlyCredits: 15,
    hourlyCreditsFull: 15,
    hourlyCreditsArchived: 7.5,
    createdBy: { id: 'u-1', name: 'alice' },
    createdAt: '2026-11-01T08:00:00.000Z',
    attachedCloudHostId: null,
    attachedCloudHostName: null,
    attachedAt: null,
    currentArchive: null,
    archiveSpace: { capacityGi: 100, usedGi: null },
    failureReason: null,
    destroyedAt: null,
    ...overrides,
  };
}

describe('NewCloudHostDialog 云存储区块', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatedHost();
  });

  it('T-WEB3 勾选后下拉仅含 IDLE/ARCHIVED，并展示名称/容量/状态/费用/创建人', () => {
    installQueryMocks({
      storageEnabled: true,
      storages: [
        makeStorage(),
        makeStorage({
          id: 'st-archived',
          name: '已归档存储',
          status: 'ARCHIVED',
          hourlyCredits: 7.5,
        }),
        makeStorage({ id: 'st-attached', name: '已挂载存储', status: 'ATTACHED' }),
      ],
    });
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('挂载云存储'));

    expect(screen.getByRole('option', { name: /待挂载存储 · 20Gi · 待挂载 · 15 credits\/小时 · alice/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /已归档存储 · 20Gi · 已归档 · 7.5 credits\/小时 · alice/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /已挂载存储/ })).not.toBeInTheDocument();
  })

  it('T-WEB3 选择已归档存储展示恢复提示，提交携带 storageId 与存储费用', async () => {
    installQueryMocks({
      storageEnabled: true,
      storages: [
        makeStorage({
          id: 'st-archived',
          name: '已归档存储',
          status: 'ARCHIVED',
          hourlyCredits: 7.5,
        }),
      ],
    });
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('挂载云存储'));
    fireEvent.change(screen.getByLabelText('云存储'), { target: { value: 'st-archived' } });

    expect(
      screen.getByText('该存储已归档，启动时将先恢复数据，耗时取决于数据量'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('存储费用：15 credits/小时（挂载期间按全价计费；归档后 7.5 credits/小时）'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('该存储已归档，启动时先恢复数据，恢复完成后挂载期间按全价计费'),
    ).toBeInTheDocument();
    // 并列列示云存储小时费用并计入合计
    expect(screen.getByText('云存储：15 credits/小时')).toBeInTheDocument();
    expect(screen.getByTestId('cloud-host-hourly-total')).toHaveTextContent(
      '合计运行费用：835 credits/小时',
    );

    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(mockCreateCloudHost).toHaveBeenCalledWith({
        variables: {
          input: {
            name: '云电脑 A',
            harnessTypes: [],
            specId: 'spec-8c',
            storageId: 'st-archived',
          },
        },
      });
    });
  })

  it('T-WEB4 新建…创建成功后自动选中新存储', async () => {
    installQueryMocks({ storageEnabled: true, storages: [] });
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('挂载云存储'));
    fireEvent.click(screen.getByRole('button', { name: '新建…' }));

    expect(screen.getByTestId('new-cloud-storage-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByText('完成新建存储'));
    await waitFor(() => {
      expect(screen.getByLabelText('云存储')).toHaveValue('st-new');
    });

    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(mockCreateCloudHost).toHaveBeenCalledWith({
        variables: {
          input: {
            name: '云电脑 A',
            harnessTypes: [],
            specId: 'spec-8c',
            storageId: 'st-new',
          },
        },
      });
    });
  })

  it('T-WEB5 未勾选云存储时请求体不含 storageId（报文形状不变）', async () => {
    installQueryMocks({ storageEnabled: true, storages: [makeStorage()] });
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(mockCreateCloudHost).toHaveBeenCalled();
    });
    const input = mockCreateCloudHost.mock.calls[0][0].variables.input;
    expect(input).toEqual({ name: '云电脑 A', harnessTypes: [], specId: 'spec-8c' });
    expect(Object.keys(input).sort()).toEqual(['harnessTypes', 'name', 'specId']);
  })

  it('云存储能力关闭时隐藏整个区块', () => {
    installQueryMocks({ storageEnabled: false, storages: [makeStorage()] });
    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.queryByLabelText('挂载云存储')).not.toBeInTheDocument();
    expect(screen.queryByText('云存储（可选）')).not.toBeInTheDocument();
  })
})
