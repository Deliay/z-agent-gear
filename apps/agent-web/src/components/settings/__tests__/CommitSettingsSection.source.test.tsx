import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import CommitSettingsSection from '../CommitSettingsSection';
import type { CommitSettingsData } from '@/graphql/types';

const mockUseQuery = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [vi.fn(), { loading: false }],
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SETTINGS: CommitSettingsData = {
  committerMode: 'CO_AUTHOR',
  committerType: 'CUSTOM',
  githubAccountId: null,
  customName: 'Agent',
  customEmail: 'agent@example.com',
  source: 'GLOBAL',
  readOnly: false,
};

function mockSettings(settings: CommitSettingsData) {
  mockUseQuery.mockImplementation((query: { definitions?: Array<{ name?: { value?: string } }> }) => {
    const operationName = query?.definitions?.[0]?.name?.value;
    if (operationName === 'GetCommitSettings') {
      return { data: { commitSettings: settings }, loading: false };
    }
    return { data: { githubAccounts: [] }, loading: false };
  });
}

describe('CommitSettingsSection 继承来源与只读收敛', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings(SETTINGS);
  });

  it('展示「继承自全局工作区」来源徽标', () => {
    render(<CommitSettingsSection />);
    const badge = screen.getByTestId('commit-settings-source');
    expect(badge).toHaveTextContent('继承自全局工作区');
    expect(badge).toHaveAttribute('data-source', 'GLOBAL');
    expect(screen.getByRole('button', { name: '保存 Commit 设置' })).toBeEnabled();
  });

  it('本工作区已设置时展示「本工作区」', () => {
    mockSettings({ ...SETTINGS, source: 'WORKSPACE' });
    render(<CommitSettingsSection />);
    expect(screen.getByTestId('commit-settings-source')).toHaveTextContent('本工作区');
  });

  it('readOnly 上下文隐藏保存能力并提示只读', () => {
    mockSettings({ ...SETTINGS, source: 'WORKSPACE', readOnly: true });
    render(<CommitSettingsSection />);

    expect(screen.getByText('全局工作区对开发者只读，不可修改 Commit 设置')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存 Commit 设置' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Co-Author' })).toBeDisabled();
  });
});
