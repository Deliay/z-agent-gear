import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../../stores/AuthProvider';
import LoginPage from '../LoginPage';

const mocks = vi.hoisted(() => ({
  setAdminApiBase: vi.fn(),
  clearAdminApiBase: vi.fn(),
  reloadApp: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  useMutation: vi.fn(),
  mutate: vi.fn(),
  capturedOptions: { current: null as null | {
    onCompleted?: (data: unknown) => void;
    onError?: (err: Error) => void;
  } },
}));

vi.mock('@apollo/client', () => ({ gql: vi.fn(() => '') }));
vi.mock('@apollo/client/react', () => ({ useMutation: mocks.useMutation }));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, message: vi.fn() },
}));
vi.mock('@/lib/api-base', () => ({
  setAdminApiBase: mocks.setAdminApiBase,
  clearAdminApiBase: mocks.clearAdminApiBase,
  getAdminApiBase: vi.fn(() => ''),
}));
vi.mock('@/lib/runtime', () => ({ reloadApp: mocks.reloadApp }));

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/models" element={<div>models page</div>} />
          <Route path="/change-password" element={<div>change password page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.useMutation.mockImplementation((_doc: unknown, options: unknown) => {
      mocks.capturedOptions.current = options as typeof mocks.capturedOptions.current;
      return [mocks.mutate, { loading: false }];
    });
  });

  it('T-F7: renders login form with no registration entry', () => {
    renderLogin();
    expect(screen.getByRole('button', { name: '登录' })).toBeDefined();
    expect(screen.getByLabelText('用户名')).toBeDefined();
    expect(screen.getByLabelText('密码')).toBeDefined();
    expect(screen.queryByText(/注册/)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('T-F2: saves server address when the probe succeeds', async () => {
    mocks.setAdminApiBase.mockResolvedValue(true);
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: '服务器地址' }));
    fireEvent.change(screen.getByLabelText('服务器地址'), {
      target: { value: 'http://custom.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mocks.setAdminApiBase).toHaveBeenCalledWith('http://custom.example.com'));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(mocks.reloadApp).toHaveBeenCalled();
  });

  it('T-F2: shows error and does not reload when the probe fails', async () => {
    mocks.setAdminApiBase.mockResolvedValue(false);
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: '服务器地址' }));
    fireEvent.change(screen.getByLabelText('服务器地址'), {
      target: { value: 'http://unreachable.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.reloadApp).not.toHaveBeenCalled();
  });

  it('T-F2: restores default server address', () => {
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: '服务器地址' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));

    expect(mocks.clearAdminApiBase).toHaveBeenCalled();
    expect(mocks.reloadApp).toHaveBeenCalled();
  });

  it('navigates to /change-password when mustChangePassword is true', () => {
    renderLogin();
    act(() => {
      mocks.capturedOptions.current?.onCompleted?.({
        adminLogin: {
          token: 'token-1',
          admin: { id: '1', username: 'admin', mustChangePassword: true },
        },
      });
    });
    expect(screen.getByText('change password page')).toBeDefined();
  });

  it('navigates to /models when password already changed', () => {
    renderLogin();
    act(() => {
      mocks.capturedOptions.current?.onCompleted?.({
        adminLogin: {
          token: 'token-1',
          admin: { id: '1', username: 'admin', mustChangePassword: false },
        },
      });
    });
    expect(screen.getByText('models page')).toBeDefined();
  });

  it('submits the entered username and password through the mutation', () => {
    renderLogin();

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(mocks.mutate).toHaveBeenCalledWith({
      variables: { username: 'admin', password: 'hunter2' },
    });
  });

  it('shows a business error message without opening the server settings', () => {
    renderLogin();

    act(() => {
      mocks.capturedOptions.current?.onError?.(new Error('用户名或密码错误'));
    });

    expect(screen.getByRole('alert').textContent).toContain('用户名或密码错误');
    expect(screen.queryByLabelText('服务器地址')).toBeNull();
  });

  it('treats a network failure as unreachable and opens the server settings', () => {
    renderLogin();

    act(() => {
      mocks.capturedOptions.current?.onError?.(new Error('Failed to fetch'));
    });

    expect(screen.getByRole('alert').textContent).toContain('无法连接服务器');
    expect(screen.getByLabelText('服务器地址')).toBeDefined();
  });
});
