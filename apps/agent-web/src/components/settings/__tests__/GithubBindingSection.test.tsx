import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import GithubBindingSection from '../GithubBindingSection';

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockUseSearchParams = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock('react-router-dom', () => ({
  useSearchParams: (...args: unknown[]) => mockUseSearchParams(...args),
}));

function mockQuery(overrides: Record<string, unknown> = {}) {
  return {
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  };
}

const defaultAppUrlData = { githubAppUrl: { url: 'https://github.com/apps/test/installations/new?state=abc', state: 'abc' } };

describe('GithubBindingSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue([vi.fn(), { loading: false }]);
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
  });

  it('should show loading state', () => {
    mockUseQuery
      .mockReturnValueOnce(mockQuery({ loading: true }))
      .mockReturnValueOnce(mockQuery({ loading: true }));

    render(<GithubBindingSection />);

    expect(screen.getByText('加载中...')).toBeDefined();
  });

  it('should show empty state when no accounts bound', () => {
    mockUseQuery
      .mockReturnValueOnce(mockQuery({ data: { githubAccounts: [] } }))
      .mockReturnValueOnce(mockQuery({ data: defaultAppUrlData }));

    render(<GithubBindingSection />);

    expect(screen.getByText(/暂无绑定/)).toBeDefined();
    expect(screen.getByRole('button', { name: '绑定 GitHub 帐号' })).toBeDefined();
  });

  it('should render account list when accounts exist and expand repos', () => {
    mockUseQuery
      .mockReturnValueOnce(mockQuery({
        data: {
          githubAccounts: [
            {
              id: 'acc1',
              githubUserId: 12345,
              githubLogin: 'testuser',
              githubAvatarUrl: null,
              installations: [
                {
                  id: 'inst1',
                  installationId: 42,
                  repos: [
                    {
                      id: 'repo1',
                      repoId: 1,
                      repoName: 'my-repo',
                      fullName: 'testuser/my-repo',
                      private: false,
                      permissions: { read: true, write: true },
                    },
                  ],
                  createdAt: '2026-01-01T00:00:00Z',
                },
              ],
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
        },
      }))
      .mockReturnValueOnce(mockQuery({ data: defaultAppUrlData }));

    render(<GithubBindingSection />);

    expect(screen.getByText('testuser')).toBeDefined();
    expect(screen.getByText('查看仓库')).toBeDefined();
  });

  it('should render multiple accounts', () => {
    mockUseQuery
      .mockReturnValueOnce(mockQuery({
        data: {
          githubAccounts: [
            { id: 'acc1', githubUserId: 1, githubLogin: 'user1', githubAvatarUrl: null, installations: [], createdAt: '2026-01-01T00:00:00Z' },
            { id: 'acc2', githubUserId: 2, githubLogin: 'user2', githubAvatarUrl: null, installations: [], createdAt: '2026-01-01T00:00:00Z' },
          ],
        },
      }))
      .mockReturnValueOnce(mockQuery({ data: defaultAppUrlData }));

    render(<GithubBindingSection />);

    expect(screen.getByText('user1')).toBeDefined();
    expect(screen.getByText('user2')).toBeDefined();
  });
});
