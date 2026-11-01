import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import GitSettingsSection from '../GitSettingsSection';
import { GET_COMMIT_SETTINGS } from '@/graphql/queries';
import type { CommitSettings, PersonalGithubAccount } from '@/graphql/types';

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

const UNSET_SETTINGS: CommitSettings = {
  committerType: 'UNSET',
  customName: null,
  customEmail: null,
  commitWithBot: false,
};

const ACCOUNTS: PersonalGithubAccount[] = [
  {
    id: 'acc1',
    githubUserId: 1,
    githubLogin: 'octocat',
    githubAvatarUrl: 'https://avatars.example/1.png',
  },
];

interface MockQueryOptions {
  settings?: CommitSettings | null;
  accounts?: PersonalGithubAccount[];
  settingsLoading?: boolean;
}

function mockQueries({
  settings = UNSET_SETTINGS,
  accounts = ACCOUNTS,
  settingsLoading = false,
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
      data: { personalGithubAccounts: accounts },
      loading: false,
      error: null,
      refetch: vi.fn(),
    };
  });
}

function typeGroup() {
  return within(screen.getByRole('radiogroup', { name: '提交人' }));
}

function saveButton() {
  return screen.getByRole('button', { name: '保存 Git 设置' });
}

describe('GitSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueries();
    mockUseMutation.mockReturnValue([mockUpdateCommitSettings, { loading: false }]);
    mockUpdateCommitSettings.mockResolvedValue({
      data: { updateCommitSettings: UNSET_SETTINGS },
    });
  });

  // T-FE-G1：区块展示 / 保存 / 未设置
  describe('T-FE-G1 保存与未设置', () => {
    it('渲染「Git」区块标题、云电脑提示与默认「未设置」', () => {
      render(<GitSettingsSection />);

      expect(screen.getByRole('heading', { name: 'Git' })).toBeInTheDocument();
      expect(screen.getByText('仅对云电脑环境生效')).toBeInTheDocument();
      expect(typeGroup().getByRole('radio', { name: '未设置' })).toBeChecked();
      expect(typeGroup().getByRole('radio', { name: '自定义' })).not.toBeChecked();
      expect(screen.queryByLabelText('用户名')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('邮箱')).not.toBeInTheDocument();
      expect(saveButton()).toBeEnabled();
    });

    it('保存「未设置」提交 UNSET 并提示对成员 Worktree 生效', async () => {
      render(<GitSettingsSection />);

      fireEvent.click(saveButton());

      await waitFor(() => {
        expect(mockUpdateCommitSettings).toHaveBeenCalledWith({
          variables: {
            input: {
              committerType: 'UNSET',
              customName: null,
              customEmail: null,
              commitWithBot: false,
            },
          },
        });
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('对成员的会话/工作流 Worktree 生效');
    });

    it('加载分支只在 loading && !data 时展示加载态', () => {
      mockQueries({ settings: null, settingsLoading: true });
      render(<GitSettingsSection />);

      expect(screen.getByText('加载中...')).toBeInTheDocument();
    });

    it('查询使用 cache-and-network，保存后重拉 GetCommitSettings', () => {
      render(<GitSettingsSection />);

      expect(mockUseQuery).toHaveBeenCalledWith(
        GET_COMMIT_SETTINGS,
        expect.objectContaining({ fetchPolicy: 'cache-and-network' }),
      );
      expect(mockUseMutation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ refetchQueries: [GET_COMMIT_SETTINGS] }),
      );
    });
  });

  // T-FE-G2：自定义校验（空用户名 / 非法邮箱）
  describe('T-FE-G2 自定义校验', () => {
    it('空用户名与非法邮箱均拦截保存并提示格式不正确', () => {
      render(<GitSettingsSection />);

      fireEvent.click(typeGroup().getByRole('radio', { name: '自定义' }));

      expect(screen.getByText('提交人用户名或邮箱格式不正确')).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();

      fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'Zero Ash' } });
      fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'not-an-email' } });
      expect(screen.getByText('提交人用户名或邮箱格式不正确')).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();

      fireEvent.click(saveButton());
      expect(mockUpdateCommitSettings).not.toHaveBeenCalled();
    });

    it('用户名超长（>100）被拦截', () => {
      render(<GitSettingsSection />);

      fireEvent.click(typeGroup().getByRole('radio', { name: '自定义' }));
      fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'a'.repeat(101) } });
      fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'zero@example.com' } });

      // 单行 input 会剔除换行/NUL（等价于浏览器行为），超长是 UI 可构造的边界用例。
      expect(screen.getByText('提交人用户名或邮箱格式不正确')).toBeInTheDocument();
      expect(saveButton()).toBeDisabled();
    });

    it('合法用户名与邮箱放行保存', () => {
      render(<GitSettingsSection />);

      fireEvent.click(typeGroup().getByRole('radio', { name: '自定义' }));
      fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'Zero Ash' } });
      fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'zero@example.com' } });

      expect(screen.queryByText('提交人用户名或邮箱格式不正确')).not.toBeInTheDocument();
      expect(saveButton()).toBeEnabled();
    });

    it('服务端 invalid custom committer 映射为格式不正确文案', async () => {
      mockUpdateCommitSettings.mockRejectedValueOnce(new Error('invalid custom committer'));
      mockQueries({
        settings: {
          committerType: 'CUSTOM',
          customName: 'Zhang San',
          customEmail: 'zhangsan@example.com',
          commitWithBot: false,
        },
      });
      render(<GitSettingsSection />);

      fireEvent.click(saveButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('提交人用户名或邮箱格式不正确');
    });

    it('未知服务端错误原样展示', async () => {
      mockUpdateCommitSettings.mockRejectedValueOnce(new Error('unexpected backend failure'));
      mockQueries({
        settings: {
          committerType: 'CUSTOM',
          customName: 'Zhang San',
          customEmail: 'zhangsan@example.com',
          commitWithBot: false,
        },
      });
      render(<GitSettingsSection />);

      fireEvent.click(saveButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('unexpected backend failure');
    });
  });

  // T-FE-G4：与 bot 共同提交
  describe('T-FE-G4 与 bot 共同提交', () => {
    it('未设置提交人时勾选项置灰并提示', () => {
      render(<GitSettingsSection />);

      const checkbox = screen.getByRole('checkbox', { name: '与 bot 共同提交' });
      expect(checkbox).not.toBeChecked();
      expect(checkbox).toBeDisabled();
      expect(screen.getByText('设置提交人后可勾选')).toBeInTheDocument();
    });

    it('自定义 + 勾选后保存提交 commitWithBot=true', async () => {
      render(<GitSettingsSection />);

      fireEvent.click(typeGroup().getByRole('radio', { name: '自定义' }));
      fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'Zhang San' } });
      fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'zhangsan@example.com' } });
      fireEvent.click(screen.getByRole('checkbox', { name: '与 bot 共同提交' }));

      expect(screen.getByRole('checkbox', { name: '与 bot 共同提交' })).toBeChecked();
      fireEvent.click(saveButton());

      await waitFor(() => {
        expect(mockUpdateCommitSettings).toHaveBeenCalledWith({
          variables: {
            input: {
              committerType: 'CUSTOM',
              customName: 'Zhang San',
              customEmail: 'zhangsan@example.com',
              commitWithBot: true,
            },
          },
        });
      });
    });

    it('服务端返回 commitWithBot=true 时正确回显勾选', () => {
      mockQueries({
        settings: {
          committerType: 'CUSTOM',
          customName: 'Zhang San',
          customEmail: 'zhangsan@example.com',
          commitWithBot: true,
        },
      });
      render(<GitSettingsSection />);

      expect(screen.getByRole('checkbox', { name: '与 bot 共同提交' })).toBeChecked();
    });

    it('切换回未设置时取消勾选并按 false 保存', async () => {
      mockQueries({
        settings: {
          committerType: 'CUSTOM',
          customName: 'Zhang San',
          customEmail: 'zhangsan@example.com',
          commitWithBot: true,
        },
      });
      render(<GitSettingsSection />);

      fireEvent.click(typeGroup().getByRole('radio', { name: '未设置' }));
      expect(screen.getByRole('checkbox', { name: '与 bot 共同提交' })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: '与 bot 共同提交' })).toBeDisabled();

      fireEvent.click(saveButton());
      await waitFor(() => {
        expect(mockUpdateCommitSettings).toHaveBeenCalledWith({
          variables: {
            input: {
              committerType: 'UNSET',
              customName: null,
              customEmail: null,
              commitWithBot: false,
            },
          },
        });
      });
    });
  });

  // T-FE-G3：保存回显
  describe('T-FE-G3 保存回显', () => {
    it('自定义设置回显到输入框', () => {
      mockQueries({
        settings: {
          committerType: 'CUSTOM',
          customName: 'Zhang San',
          customEmail: 'zhangsan@example.com',
          commitWithBot: false,
        },
      });
      render(<GitSettingsSection />);

      expect(typeGroup().getByRole('radio', { name: '自定义' })).toBeChecked();
      expect((screen.getByLabelText('用户名') as HTMLInputElement).value).toBe('Zhang San');
      expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('zhangsan@example.com');
    });

    it('保存后 trim 提交并回显服务端权威返回值', async () => {
      mockUpdateCommitSettings.mockResolvedValue({
        data: {
          updateCommitSettings: {
            committerType: 'CUSTOM',
            customName: 'Zhang San',
            customEmail: 'zhangsan@example.com',
            commitWithBot: false,
          },
        },
      });
      render(<GitSettingsSection />);

      fireEvent.click(typeGroup().getByRole('radio', { name: '自定义' }));
      fireEvent.change(screen.getByLabelText('用户名'), { target: { value: '  Zhang San ' } });
      fireEvent.change(screen.getByLabelText('邮箱'), {
        target: { value: ' zhangsan@example.com ' },
      });
      fireEvent.click(saveButton());

      await waitFor(() => {
        expect(mockUpdateCommitSettings).toHaveBeenCalledWith({
          variables: {
            input: {
              committerType: 'CUSTOM',
              customName: 'Zhang San',
              customEmail: 'zhangsan@example.com',
              commitWithBot: false,
            },
          },
        });
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('对成员的会话/工作流 Worktree 生效');

      await waitFor(() => {
        expect((screen.getByLabelText('用户名') as HTMLInputElement).value).toBe('Zhang San');
      });
      expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe(
        'zhangsan@example.com',
      );
    });

    it('用户已编辑后新查询结果不覆盖表单（dirty 保护）', () => {
      const { rerender } = render(<GitSettingsSection />);
      fireEvent.click(typeGroup().getByRole('radio', { name: '自定义' }));
      fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'Draft Name' } });

      mockQueries({
        settings: {
          committerType: 'CUSTOM',
          customName: 'Zhang San',
          customEmail: 'zhangsan@example.com',
          commitWithBot: false,
        },
      });
      rerender(<GitSettingsSection />);

      expect((screen.getByLabelText('用户名') as HTMLInputElement).value).toBe('Draft Name');
    });
  });
});
