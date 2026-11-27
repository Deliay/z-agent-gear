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

  it('T-AUI-NAV1: 渲染四分组导航且 11 个入口路径逐一对齐', () => {
    renderLayout();
    for (const group of ['云资源管理', '模型与 Harness', '租户与计费', '系统安全']) {
      expect(screen.getByRole('heading', { name: group })).toBeInTheDocument();
    }

    const expected: Array<[string, string]> = [
      ['云端容器', '/cloud-containers'],
      ['容器规格', '/cloud-host-specs'],
      ['工作负载', '/cloud-workloads'],
      ['基础镜像', '/base-images'],
      ['模型配置', '/models'],
      ['Harness 配置', '/harness-configs'],
      ['租户管理', '/tenants'],
      ['费用中心', '/billing'],
      ['对账中心', '/reconciliation'],
      ['登录认证', '/auth-providers'],
      ['账号安全', '/settings/security'],
    ];
    for (const [name, href] of expected) {
      const link = screen.getByRole('link', { name });
      expect(link).toHaveAttribute('href', href);
    }
  });

  it('T-AUI-NAV2: 当前路由 aria-current、主题切换、Skip Link 与主内容锚点', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: '模型配置' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      screen.getByRole('button', { name: /切换主题（当前：/ }),
    ).toBeInTheDocument();
    const skipLink = screen.getByRole('link', { name: '跳到主要内容' });
    expect(skipLink).toHaveAttribute('href', '#main-content');
    expect(document.getElementById('main-content')).not.toBeNull();
  });
});
