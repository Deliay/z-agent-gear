import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import CommitSettingsSection from '../CommitSettingsSection';
import type {
  CommitSettingsData,
  GitHubAccountData,
} from '@/graphql/types';

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockUpdateCommitSettings = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: vi.fn(),
  },
}));

const UNSET_SETTINGS: CommitSettingsData = {
  committerMode: 'UNSET',
  committerType: 'UNSET',
  githubAccountId: null,
  customName: null,
  customEmail: null,
};

const ACCOUNTS: GitHubAccountData[] = [
  {
    id: 'acc1',
    githubUserId: 1,
    githubLogin: 'octocat',
    githubAvatarUrl: 'https://avatars.example/1.png',
    installations: [],
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'acc2',
    githubUserId: 2,
    githubLogin: 'hubot',
    githubAvatarUrl: 'https://avatars.example/2.png',
    installations: [],
    createdAt: '2026-01-01T00:00:00Z',
  },
];

interface MockQueryOptions {
  settings?: CommitSettingsData | null;
  accounts?: GitHubAccountData[] | null;
  settingsLoading?: boolean;
  accountsLoading?: boolean;
}

function mockQueries({
  settings = UNSET_SETTINGS,
  accounts = ACCOUNTS,
  settingsLoading = false,
  accountsLoading = false,
}: MockQueryOptions = {}) {
  mockUseQuery.mockImplementation((query: { definitions?: Array<{ name?: { value?: string } }> }) => {
    const operationName = query?.definitions?.[0]?.name?.value;
    if (operationName === 'GetCommitSettings') {
      return {
        data: settings ? { commitSettings: settings } : null,
        loading: settingsLoading,
        error: null,
        refetch: vi.fn(),
      };
    }
    return {
      data: accounts ? { githubAccounts: accounts } : null,
      loading: accountsLoading,
      error: null,
      refetch: vi.fn(),
    };
  });
}

function modeGroup() {
  return within(screen.getByRole('radiogroup', { name: '提交人模式' }));
}

function typeGroup() {
  return within(screen.getByRole('radiogroup', { name: '提交人' }));
}

function saveButton() {
  return screen.getByRole('button', { name: '保存 Commit 设置' });
}

describe('CommitSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueries();
    mockUseMutation.mockReturnValue([mockUpdateCommitSettings, { loading: false }]);
    mockUpdateCommitSettings.mockResolvedValue({
      data: { updateCommitSettings: UNSET_SETTINGS },
    });
  });

  it('渲染区块标题、常驻提示与默认双 UNSET', () => {
    render(<CommitSettingsSection />);

    expect(screen.getByText('Commit 设置')).toBeInTheDocument();
    expect(screen.getByText('设置只对云容器环境生效')).toBeInTheDocument();

    expect(modeGroup().getByRole('radio', { name: '未设置' })).toBeChecked();
    expect(typeGroup().getByRole('radio', { name: '未设置' })).toBeChecked();
    expect(modeGroup().getByRole('radio', { name: '仅Agent' })).not.toBeChecked();
    expect(typeGroup().getByRole('radio', { name: 'Github帐号' })).not.toBeChecked();
    expect(saveButton()).toBeEnabled();
  });

  it('加载分支只在 loading && !data 时展示加载态', () => {
    mockQueries({ settings: null, settingsLoading: true });
    render(<CommitSettingsSection />);

    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });

  it('data 已存在时刷新中不卸载表单', () => {
    mockQueries({ settingsLoading: true });
    render(<CommitSettingsSection />);

    expect(screen.queryByText('加载中...')).not.toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: '提交人模式' })).toBeInTheDocument();
  });

  it('Co-Author / 仅人类 + 提交人未设置时禁用保存并提示', () => {
    render(<CommitSettingsSection />);

    fireEvent.click(modeGroup().getByRole('radio', { name: 'Co-Author' }));

    expect(screen.getByText('请先设置提交人')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    fireEvent.click(modeGroup().getByRole('radio', { name: '仅人类' }));
    expect(screen.getByText('请先设置提交人')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    fireEvent.click(modeGroup().getByRole('radio', { name: '仅Agent' }));
    expect(screen.queryByText('请先设置提交人')).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('Github 帐号下拉展示已绑定帐号头像与用户名且不含 org 帐号', () => {
    mockQueries({
      settings: {
        ...UNSET_SETTINGS,
        committerMode: 'CO_AUTHOR',
        committerType: 'GITHUB_ACCOUNT',
        githubAccountId: 'acc1',
      },
    });
    render(<CommitSettingsSection />);

    expect(typeGroup().getByRole('radio', { name: 'Github帐号' })).toBeChecked();

    const select = screen.getByLabelText('Github 帐号') as HTMLSelectElement;
    expect(select.value).toBe('acc1');
    const optionLabels = Array.from(select.options).map((option) => option.textContent);
    expect(optionLabels).toContain('octocat');
    expect(optionLabels).toContain('hubot');
    expect(optionLabels.some((label) => /org/i.test(label ?? ''))).toBe(false);
    expect(screen.queryByText(/Organization/)).not.toBeInTheDocument();

    expect(screen.getByAltText('octocat 头像')).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('未绑定任何 Github 帐号时下拉为空并引导绑定且不可保存', () => {
    mockQueries({
      settings: {
        ...UNSET_SETTINGS,
        committerMode: 'CO_AUTHOR',
        committerType: 'GITHUB_ACCOUNT',
        githubAccountId: null,
      },
      accounts: [],
    });
    render(<CommitSettingsSection />);

    expect(screen.getByText('请先绑定 Github 帐号')).toBeInTheDocument();
    const select = screen.getByLabelText('Github 帐号') as HTMLSelectElement;
    expect(select.options).toHaveLength(1);
    expect(saveButton()).toBeDisabled();
  });

  it('已选帐号被解绑后回显提示重新选择提交人', () => {
    mockQueries({
      settings: {
        ...UNSET_SETTINGS,
        committerMode: 'HUMAN_ONLY',
        committerType: 'GITHUB_ACCOUNT',
        githubAccountId: 'acc-removed',
      },
    });
    render(<CommitSettingsSection />);

    expect(screen.getByText('已选择的 Github 帐号已解绑，请重新选择提交人')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('自定义提交人空用户名 / 非法邮箱被拦截', () => {
    render(<CommitSettingsSection />);

    fireEvent.click(typeGroup().getByRole('radio', { name: '自定义' }));

    expect(screen.getByText('提交人用户名或邮箱格式不正确')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'Zero Ash' } });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'not-an-email' } });

    expect(screen.getByText('提交人用户名或邮箱格式不正确')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'zero@example.com' } });

    expect(screen.queryByText('提交人用户名或邮箱格式不正确')).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('保存成功调用 mutation、提示云容器生效并回显服务端返回值', async () => {
    mockUpdateCommitSettings.mockResolvedValue({
      data: {
        updateCommitSettings: {
          committerMode: 'HUMAN_ONLY',
          committerType: 'GITHUB_ACCOUNT',
          githubAccountId: 'acc2',
          customName: null,
          customEmail: null,
        },
      },
    });
    render(<CommitSettingsSection />);

    fireEvent.click(modeGroup().getByRole('radio', { name: 'Co-Author' }));
    fireEvent.click(typeGroup().getByRole('radio', { name: 'Github帐号' }));
    fireEvent.change(screen.getByLabelText('Github 帐号'), { target: { value: 'acc2' } });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(mockUpdateCommitSettings).toHaveBeenCalledWith({
        variables: {
          input: {
            committerMode: 'CO_AUTHOR',
            committerType: 'GITHUB_ACCOUNT',
            githubAccountId: 'acc2',
            customName: null,
            customEmail: null,
          },
        },
      });
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('对云容器环境生效，已运行的云电脑稍后自动更新');

    // 回显服务端权威返回（服务端归一为 HUMAN_ONLY）
    await waitFor(() => {
      expect(modeGroup().getByRole('radio', { name: '仅人类' })).toBeChecked();
    });
    expect((screen.getByLabelText('Github 帐号') as HTMLSelectElement).value).toBe('acc2');
  });

  it.each([
    ['committer is required for the selected mode', '请先设置提交人'],
    ['invalid github account', 'Github 帐号无效，请重新选择'],
    ['invalid custom committer', '提交人用户名或邮箱格式不正确'],
  ])('服务端错误 %s 逐字映射为 %s', async (serverMessage, expected) => {
    mockUpdateCommitSettings.mockRejectedValueOnce(new Error(serverMessage));
    mockQueries({
      settings: {
        ...UNSET_SETTINGS,
        committerMode: 'HUMAN_ONLY',
        committerType: 'GITHUB_ACCOUNT',
        githubAccountId: 'acc1',
      },
    });
    render(<CommitSettingsSection />);

    fireEvent.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
  });

  it('未知服务端错误原样展示', async () => {
    mockUpdateCommitSettings.mockRejectedValueOnce(new Error('unexpected backend failure'));
    mockQueries({
      settings: {
        ...UNSET_SETTINGS,
        committerMode: 'HUMAN_ONLY',
        committerType: 'GITHUB_ACCOUNT',
        githubAccountId: 'acc1',
      },
    });
    render(<CommitSettingsSection />);

    fireEvent.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('unexpected backend failure');
  });
});
