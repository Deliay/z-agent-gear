import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../stores/AuthProvider';
import LoginCallbackPage from '../LoginCallbackPage';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  captured: { current: null as null | { onCompleted?: (data: unknown) => void; onError?: () => void } },
}));

vi.mock('@apollo/client', () => ({ gql: vi.fn(() => '') }));
vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn((_doc: unknown, options: unknown) => {
    mocks.captured.current = options as typeof mocks.captured.current;
    return [mocks.mutate, { loading: false }];
  }),
}));

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <Routes>
          <Route path="/login/callback" element={<LoginCallbackPage />} />
          <Route path="/login" element={<div>login page</div>} />
          <Route path="/" element={<div>home page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginCallbackPage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('兑换 ticket 成功后写入登录态并进入首页', () => {
    renderAt('/login/callback?ticket=ticket-1');
    expect(mocks.mutate).toHaveBeenCalledWith({ variables: { ticket: 'ticket-1' } });

    act(() => {
      mocks.captured.current?.onCompleted?.({
        exchangeLoginTicket: {
          token: 'jwt-token',
          user: {
            id: 'u1',
            name: 'oauth-user',
            tenant: { id: 'u1', name: 'oauth-user', type: 'personal', memberCount: 1 },
          },
        },
      });
    });

    expect(localStorage.getItem('auth_token')).toBe('jwt-token');
    expect(screen.getByText('home page')).toBeDefined();
  });

  it('携带 error 时只展示映射文案，不发起兑换', () => {
    renderAt('/login/callback?error=not_bound');
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('该身份未绑定任何管理员账户');
  });

  it('缺少 ticket 时提示重新登录', () => {
    renderAt('/login/callback');
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('登录票据缺失');
  });

  it('兑换失败时提示票据无效且不循环重试', () => {
    renderAt('/login/callback?ticket=expired');
    act(() => {
      mocks.captured.current?.onError?.();
    });
    expect(screen.getByRole('alert').textContent).toContain('登录票据无效或已过期');
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });
});
