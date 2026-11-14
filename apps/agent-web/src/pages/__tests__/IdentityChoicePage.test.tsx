import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../stores/AuthProvider';
import IdentityChoicePage from '../IdentityChoicePage';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  mutations: [] as Array<{
    options?: { onCompleted?: (data: unknown) => void; onError?: (err: Error) => void };
    mutate: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@apollo/client', () => ({ gql: vi.fn(() => '') }));
vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: (_doc: unknown, options: unknown) => {
    const mutate = vi.fn();
    mocks.mutations.push({
      options: options as {
        onCompleted?: (data: unknown) => void;
        onError?: (err: Error) => void;
      },
      mutate,
    });
    return [mutate, { loading: false }];
  },
}));

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <Routes>
          <Route path="/login/identity-choice" element={<IdentityChoicePage />} />
          <Route path="/login" element={<div>login page</div>} />
          <Route path="/" element={<div>home page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const USER = {
  id: 'u1',
  name: 'alice',
  tenant: { id: 'u1', name: 'alice', type: 'personal', memberCount: 1 },
};

describe('IdentityChoicePage（T-OBO-WEB）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mutations = [];
    localStorage.clear();
    mocks.useQuery.mockReturnValue({
      data: {
        pendingExternalLoginInfo: {
          providerDisplayName: '公司 SSO',
          externalUsername: 'octo',
        },
      },
      loading: false,
    });
  });

  it('展示登录方式与外部帐号名（摘要白名单）', () => {
    renderAt('/login/identity-choice?pending=p1');
    expect(screen.getByText('公司 SSO')).toBeDefined();
    expect(screen.getByText('octo')).toBeDefined();
    expect(screen.getByRole('button', { name: '绑定并登录' })).toBeDefined();
    expect(screen.getByRole('button', { name: '创建新帐号' })).toBeDefined();
  });

  it('缺少 pending 或查询返回 null → 登录状态已过期并引导回登录页', () => {
    mocks.useQuery.mockReturnValue({ data: null, loading: false });
    renderAt('/login/identity-choice?pending=p1');
    expect(screen.getByRole('alert').textContent).toContain('登录状态已过期');
    fireEvent.click(screen.getByRole('button', { name: '返回登录' }));
    expect(screen.getByText('login page')).toBeDefined();
  });

  it('绑定成功 → 写入登录态并进入首页', () => {
    renderAt('/login/identity-choice?pending=p1');
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret1' } });
    const bind = mocks.mutations[mocks.mutations.length - 2];
    const form = screen.getByRole('button', { name: '绑定并登录' }).closest('form');
    expect(form).toBeTruthy();
    fireEvent.submit(form as HTMLFormElement);

    expect(bind.mutate).toHaveBeenCalledWith({
      variables: { pendingToken: 'p1', username: 'alice', password: 'secret1' },
    });

    act(() => {
      bind.options?.onCompleted?.({
        bindExternalLoginWithPassword: { token: 'jwt-1', user: USER },
      });
    });
    expect(localStorage.getItem('auth_token')).toBe('jwt-1');
    expect(screen.getByText('home page')).toBeDefined();
  });

  it('验密失败按契约文案就地展示，可重试（不跳页、不消费上下文）', () => {
    renderAt('/login/identity-choice?pending=p1');
    act(() => {
      mocks.mutations[mocks.mutations.length - 2].options?.onError?.(new Error('Invalid username or password'));
    });
    expect(screen.getByRole('alert').textContent).toContain('Invalid username or password');
    expect(screen.getByRole('button', { name: '绑定并登录' })).toBeDefined();
  });

  it('创建新帐号成功 → 登录并进入首页', () => {
    renderAt('/login/identity-choice?pending=p1');
    fireEvent.click(screen.getByRole('button', { name: '创建新帐号' }));
    expect(mocks.mutations[mocks.mutations.length - 1].mutate).toHaveBeenCalledWith({
      variables: { pendingToken: 'p1' },
    });

    act(() => {
      mocks.mutations[mocks.mutations.length - 1].options?.onCompleted?.({
        provisionExternalLogin: { token: 'jwt-2', user: USER },
      });
    });
    expect(localStorage.getItem('auth_token')).toBe('jwt-2');
    expect(screen.getByText('home page')).toBeDefined();
  });

  it('过期上下文提交 → 映射「登录状态已过期，请重新登录」', () => {
    renderAt('/login/identity-choice?pending=p1');
    act(() => {
      mocks.mutations[mocks.mutations.length - 1].options?.onError?.(
        new Error('invalid or expired pending token'),
      );
    });
    expect(screen.getByRole('alert').textContent).toContain('登录状态已过期，请重新登录');
  });
});
