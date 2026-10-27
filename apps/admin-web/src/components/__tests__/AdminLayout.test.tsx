import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AdminLayout from '../AdminLayout';
import { AuthProvider } from '../../stores/AuthProvider';

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/models']}>
      <AuthProvider>
        <Routes>
          <Route element={<AdminLayout />}>
            <Route path="/models" element={<div>models content</div>} />
          </Route>
          <Route path="/login" element={<div>login page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AdminLayout', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('admin_token', 'valid-token');
    localStorage.setItem(
      'admin_user',
      JSON.stringify({ id: '1', username: 'admin', mustChangePassword: false }),
    );
  });

  it('renders sidebar navigation and outlet', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: '模型配置' })).toBeDefined();
    expect(screen.getByRole('link', { name: '基础镜像' })).toBeDefined();
    expect(screen.getByRole('link', { name: '工作负载' })).toBeDefined();
    expect(screen.getByRole('link', { name: '租户管理' })).toBeDefined();
    expect(screen.getByText('models content')).toBeDefined();
  });

  it('T-F6: logout clears token and navigates to /login', () => {
    renderLayout();
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    expect(screen.getByText('login page')).toBeDefined();
    expect(localStorage.getItem('admin_token')).toBeNull();
    expect(localStorage.getItem('admin_user')).toBeNull();
  });
});
