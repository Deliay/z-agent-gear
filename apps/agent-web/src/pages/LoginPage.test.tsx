import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../stores/AuthProvider';
import LoginPage from './LoginPage';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
}));

vi.mock('@apollo/client', () => ({
  gql: vi.fn(() => ''),
}));

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn(() => [
    vi.fn(),
    { loading: false, error: undefined, data: undefined },
  ]),
  useQuery: mocks.useQuery,
}));

function renderLogin(entry = '/login') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.useQuery.mockReturnValue({
      data: { authProviders: [] },
      loading: false,
      error: undefined,
    });
  });

  it('should render login form', () => {
    renderLogin();
    expect(screen.getByRole('button', { name: '登录' })).toBeDefined();
    expect(screen.getByLabelText('用户名')).toBeDefined();
    expect(screen.getByLabelText('密码')).toBeDefined();
  });

  it('should not expose any registration entry (注册已硬关闭)', () => {
    renderLogin();
    expect(screen.queryByText(/注册/)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(/没有账号/)).toBeNull();
  });

  it('should render enabled third-party providers as login buttons', () => {
    mocks.useQuery.mockReturnValue({
      data: {
        authProviders: [
          { id: 'p1', type: 'oidc', displayName: '公司 SSO' },
          { id: 'p2', type: 'github_oauth', displayName: 'GitHub' },
        ],
      },
      loading: false,
      error: undefined,
    });
    renderLogin();
    expect(screen.getByRole('button', { name: '使用 公司 SSO 登录' })).toBeDefined();
    expect(screen.getByRole('button', { name: '使用 GitHub 登录' })).toBeDefined();
  });

  it('should silently fall back to password login when provider query fails', () => {
    mocks.useQuery.mockReturnValue({
      data: undefined,
      loading: false,
      error: new Error('network'),
    });
    renderLogin();
    expect(screen.getByRole('button', { name: '登录' })).toBeDefined();
    expect(screen.queryByText('或使用第三方帐号登录')).toBeNull();
  });

  it.each([
    ['access_denied', '已取消授权'],
    ['invalid_state', '登录状态已过期，请重试'],
    ['provider_error', '第三方登录服务不可用，请稍后重试'],
    ['provider_unavailable', '该登录方式已停用'],
    ['provision_failed', '账户开通失败，请联系管理员'],
    ['unknown_code', 'unknown_code'],
  ])('should map oauth error %s to friendly text', (code, expected) => {
    renderLogin(`/login?error=${code}`);
    expect(screen.getByRole('alert').textContent).toContain(expected);
  });
});
