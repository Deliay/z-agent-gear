import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import TenantDetailPage from '@/pages/TenantDetailPage';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: () => [vi.fn(), { loading: false }],
}));

function BillingProbe() {
  const location = useLocation();
  return <div>账单页{location.search}</div>;
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/tenants/t1']}>
      <Routes>
        <Route path="/tenants/:id" element={<TenantDetailPage />} />
        <Route path="/billing" element={<BillingProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const detail = {
  id: 't1',
  name: 'alice',
  type: 'personal',
  createdAt: '2026-10-01T00:00:00.000Z',
  users: [
    {
      id: 'u1',
      name: 'alice',
      username: 'alice',
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ],
};

describe('TenantDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染租户概要与成员列表，且只读无编辑/删除/停用入口', () => {
    mocks.useQuery.mockReturnValue({
      data: { adminTenant: detail },
      loading: false,
      error: undefined,
      refetch: mocks.refetch,
    });
    renderDetail();

    expect(screen.getByRole('heading', { name: 'alice' })).toBeDefined();
    expect(screen.getByText('个人')).toBeDefined();
    expect(screen.getByText('成员数')).toBeDefined();
    expect(screen.getByText('用户名')).toBeDefined();
    expect(screen.getByText('alice', { selector: 'div.font-medium' })).toBeDefined();
    expect(screen.getByRole('button', { name: '充值' })).toBeDefined();
    // 只读：无编辑/删除/停用入口
    expect(screen.queryByRole('button', { name: /编辑|删除|停用/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /编辑|删除|停用/ })).toBeNull();
  });

  it('充值入口跳转费用中心并按 tenant 计费账户预检', () => {
    mocks.useQuery.mockReturnValue({
      data: { adminTenant: detail },
      loading: false,
      error: undefined,
      refetch: mocks.refetch,
    });
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: '充值' }));

    expect(screen.getByText(/账单页\?ownerType=tenant&keyword=t1/)).toBeDefined();
  });

  it('租户不存在时展示提示', () => {
    mocks.useQuery.mockReturnValue({
      data: { adminTenant: null },
      loading: false,
      error: undefined,
      refetch: mocks.refetch,
    });
    renderDetail();
    expect(screen.getByText('租户不存在或已被移除')).toBeDefined();
  });
});
