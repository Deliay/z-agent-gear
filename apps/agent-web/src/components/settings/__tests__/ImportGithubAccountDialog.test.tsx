import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import GitSettingsSection from '../GitSettingsSection';
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
};

const ACCOUNTS: PersonalGithubAccount[] = [
  {
    id: 'acc1',
    githubUserId: 1,
    githubLogin: 'octocat',
    githubAvatarUrl: 'https://avatars.example/1.png',
  },
  {
    id: 'acc2',
    githubUserId: 2,
    githubLogin: 'hubot',
    githubAvatarUrl: null,
  },
];

interface MockQueryOptions {
  settings?: CommitSettings;
  accounts?: PersonalGithubAccount[];
}

function mockQueries({
  settings = UNSET_SETTINGS,
  accounts = ACCOUNTS,
}: MockQueryOptions = {}) {
  mockUseQuery.mockImplementation((query: { definitions?: Array<{ name?: { value?: string } }> }) => {
    const operationName = query?.definitions?.[0]?.name?.value;
    if (operationName === 'GetPersonalGithubAccounts') {
      return {
        data: { personalGithubAccounts: accounts },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    return {
      data: { commitSettings: settings },
      loading: false,
      error: null,
      refetch: vi.fn(),
    };
  });
}

/** 打开「Git」区块里的「导入Github帐号信息」弹窗（弹窗由区块挂载）。 */
async function openImportDialog() {
  render(<GitSettingsSection />);
  fireEvent.click(within(screen.getByRole('radiogroup', { name: '提交人' })).getByRole('radio', { name: '自定义' }));
  fireEvent.click(screen.getByRole('button', { name: '导入Github帐号信息' }));
  return screen.findByRole('dialog');
}

describe('ImportGithubAccountDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueries();
    mockUseMutation.mockReturnValue([mockUpdateCommitSettings, { loading: false }]);
    mockUpdateCommitSettings.mockResolvedValue({
      data: { updateCommitSettings: UNSET_SETTINGS },
    });
  });

  // T-FE-G4：帐号列表（头像 + 帐号名）
  describe('T-FE-G4 帐号列表', () => {
    it('列出个人 Github 帐号的头像与帐号名', async () => {
      const dialog = await openImportDialog();

      expect(within(dialog).getByLabelText('个人 Github 帐号列表')).toBeInTheDocument();
      expect(within(dialog).getByText('octocat')).toBeInTheDocument();
      expect(within(dialog).getByText('hubot')).toBeInTheDocument();
      expect(within(dialog).getByAltText('octocat 头像')).toHaveAttribute(
        'src',
        'https://avatars.example/1.png',
      );
      expect(
        within(dialog).getByRole('button', { name: /octocat/ }),
      ).toBeInTheDocument();
    });
  });

  // T-FE-G5：选择填充 login + noreply 且可编辑
  describe('T-FE-G5 选择填充', () => {
    it('选择帐号后填充 login 与 noreply 邮箱并可继续编辑', async () => {
      const dialog = await openImportDialog();

      fireEvent.click(within(dialog).getByRole('button', { name: /octocat/ }));

      await waitFor(() => {
        expect((screen.getByLabelText('用户名') as HTMLInputElement).value).toBe('octocat');
      });
      expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe(
        '1+octocat@users.noreply.github.com',
      );
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('用户名'), { target: { value: '自定义名字' } });
      fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'custom@example.com' } });
      expect((screen.getByLabelText('用户名') as HTMLInputElement).value).toBe('自定义名字');

      fireEvent.click(screen.getByRole('button', { name: '保存 Git 设置' }));

      await waitFor(() => {
        expect(mockUpdateCommitSettings).toHaveBeenCalledWith({
          variables: {
            input: {
              committerType: 'CUSTOM',
              customName: '自定义名字',
              customEmail: 'custom@example.com',
            },
          },
        });
      });
    });
  });

  // T-FE-G6：空态引导
  describe('T-FE-G6 空态引导', () => {
    it('无个人帐号时引导先到「GitHub 绑定」绑定帐号', async () => {
      mockQueries({ accounts: [] });
      const dialog = await openImportDialog();

      expect(within(dialog).getByText('先到『GitHub 绑定』绑定帐号')).toBeInTheDocument();
      expect(within(dialog).queryByLabelText('个人 Github 帐号列表')).not.toBeInTheDocument();
    });
  });
});
