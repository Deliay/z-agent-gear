import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../../stores/AuthProvider';
import ChangePasswordPage from '../ChangePasswordPage';

const mocks = vi.hoisted(() => ({
  useMutation: vi.fn(),
  mutate: vi.fn(),
  capturedOptions: { current: null as null | {
    onCompleted?: (data: unknown) => void;
    onError?: (err: Error) => void;
  } },
}));

vi.mock('@apollo/client', () => ({ gql: vi.fn(() => '') }));
vi.mock('@apollo/client/react', () => ({ useMutation: mocks.useMutation }));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/change-password']}>
      <AuthProvider>
        <Routes>
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route path="/models" element={<div>models page</div>} />
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function fill(oldPw: string, newPw: string, confirm: string) {
  fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: oldPw } });
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: newPw } });
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: confirm } });
}

describe('ChangePasswordPage', () => {
  beforeEach(() => {
    localStorage.clear();
    // 改密页要求已登录（未登录应重定向 /login）
    localStorage.setItem('admin_token', 'initial-token');
    localStorage.setItem('admin_user', JSON.stringify({ id: '1', username: 'admin', mustChangePassword: true }));
    vi.clearAllMocks();
    mocks.useMutation.mockImplementation((_doc: unknown, options: unknown) => {
      mocks.capturedOptions.current = options as typeof mocks.capturedOptions.current;
      return [mocks.mutate, { loading: false }];
    });
  });

  it('redirects to /login when not authenticated', () => {
    localStorage.clear();
    renderPage();
    expect(screen.getByText('login page')).toBeDefined();
  });

  it('T-F5: rejects a new password shorter than 10 characters', () => {
    renderPage();
    fill('oldpassword', 'short', 'short');
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));

    expect(screen.getByRole('alert').textContent).toContain('新密码长度至少 10 位');
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('T-F5: rejects when the two new passwords do not match', () => {
    renderPage();
    fill('oldpassword', 'newpassword1', 'newpassword2');
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));

    expect(screen.getByRole('alert').textContent).toContain('两次输入的新密码不一致');
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('T-F5: submits a valid password and enters the console on success', () => {
    renderPage();
    fill('oldpassword', 'newpassword1', 'newpassword1');
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));

    expect(mocks.mutate).toHaveBeenCalledWith({
      variables: { oldPassword: 'oldpassword', newPassword: 'newpassword1' },
    });

    act(() => {
      mocks.capturedOptions.current?.onCompleted?.({
        changeAdminPassword: {
          token: 'new-token',
          admin: { id: '1', username: 'admin', mustChangePassword: false },
        },
      });
    });

    expect(screen.getByText('models page')).toBeDefined();
    expect(localStorage.getItem('admin_token')).toBe('new-token');
  });
});
