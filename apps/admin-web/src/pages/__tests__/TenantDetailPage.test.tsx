import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import TenantDetailPage from '@/pages/TenantDetailPage';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  refetch: vi.fn(),
  addMember: vi.fn(),
  removeMember: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: (document: unknown) => {
    const text = String(document);
    if (text.includes('adminRemoveTenantMember')) {
      return [mocks.removeMember, { loading: false }];
    }
    if (text.includes('adminAddTenantMember')) {
      return [mocks.addMember, { loading: false }];
    }
    return [vi.fn(), { loading: false }];
  },
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
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

const personalDetail = {
  id: 't1',
  name: 'alice',
  type: 'personal',
  createdAt: '2026-10-01T00:00:00.000Z',
  users: [
    {
      id: 'u1',
      name: 'alice',
      username: 'alice',
      role: 'admin',
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  workspaces: [
    {
      id: 'w1',
      name: '全局工作区',
      type: 'global',
      memberCount: 0,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ],
};

const teamDetail = {
  id: 't2',
  name: '产品组',
  type: 'team',
  createdAt: '2026-10-02T00:00:00.000Z',
  users: [
    {
      id: 'u1',
      name: 'alice',
      username: 'alice',
      role: 'admin',
      createdAt: '2026-10-02T00:00:00.000Z',
    },
    {
      id: 'u2',
      name: 'bob',
      username: 'bob',
      role: 'developer',
      createdAt: '2026-10-02T00:00:00.000Z',
    },
  ],
  workspaces: [
    {
      id: 'w1',
      name: '全局工作区',
      type: 'global',
      memberCount: 0,
      createdAt: '2026-10-02T00:00:00.000Z',
    },
    {
      id: 'w2',
      name: '前端组',
      type: 'normal',
      memberCount: 2,
      createdAt: '2026-10-02T00:00:00.000Z',
    },
  ],
};

function setupDetail(detail: unknown) {
  mocks.useQuery.mockReturnValue({
    data: { adminTenant: detail },
    loading: false,
    error: undefined,
    refetch: mocks.refetch,
  });
}

describe('TenantDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('personal 租户渲染概要与只读成员列表（含角色列），无成员管理入口', () => {
    setupDetail(personalDetail);
    renderDetail();

    expect(screen.getByRole('heading', { name: 'alice' })).toBeDefined();
    expect(screen.getByText('个人')).toBeDefined();
    expect(screen.getAllByText('成员数').length).toBeGreaterThan(0);
    expect(screen.getByText('用户名')).toBeDefined();
    expect(screen.getByText('角色')).toBeDefined();
    expect(screen.getByText('管理员')).toBeDefined();
    expect(screen.getByText('alice', { selector: 'div.font-medium' })).toBeDefined();
    expect(screen.getByRole('button', { name: '充值' })).toBeDefined();
    // personal：无成员管理入口（添加/移除/变更角色）
    expect(screen.queryByRole('button', { name: '添加成员' })).toBeNull();
    expect(screen.queryByRole('button', { name: '变更角色' })).toBeNull();
    expect(screen.queryByRole('button', { name: '移除' })).toBeNull();
    // 只读：无编辑/删除/停用入口
    expect(screen.queryByRole('button', { name: /编辑|删除|停用/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /编辑|删除|停用/ })).toBeNull();
  });

  it('personal 租户展示只读工作区列表（名称/类型/成员数）', () => {
    setupDetail(personalDetail);
    renderDetail();

    expect(screen.getByRole('heading', { name: '工作区（只读）' })).toBeDefined();
    expect(screen.getByText('全局工作区')).toBeDefined();
    expect(screen.getAllByText('成员数').length).toBeGreaterThan(1);
    expect(screen.getByText('名称')).toBeDefined();
    expect(screen.getAllByText('类型').length).toBeGreaterThan(1);
    // 工作区无任何管理入口
    expect(screen.queryByRole('button', { name: /新建工作区|重命名|删除工作区/ })).toBeNull();
  });

  it('充值入口跳转费用中心并按 tenant 计费账户预检', () => {
    setupDetail(personalDetail);
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: '充值' }));

    expect(screen.getByText(/账单页\?ownerType=tenant&keyword=t1/)).toBeDefined();
  });

  it('租户不存在时展示提示', () => {
    setupDetail(null);
    renderDetail();
    expect(screen.getByText('租户不存在或已被移除')).toBeDefined();
  });

  it('team 租户成员列表含角色列与成员管理入口', () => {
    setupDetail(teamDetail);
    renderDetail();

    expect(screen.getByText('团队')).toBeDefined();
    expect(screen.getByText('管理员')).toBeDefined();
    expect(screen.getByText('开发')).toBeDefined();
    expect(screen.getByRole('button', { name: '添加成员' })).toBeDefined();
    expect(screen.getAllByRole('button', { name: '变更角色' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '移除' })).toHaveLength(2);
    // 工作区只读展示
    expect(screen.getByText('前端组')).toBeDefined();
    expect(screen.getByText('普通')).toBeDefined();
  });

  it('team 租户添加成员缺省开发角色，可切换为管理员', async () => {
    setupDetail(teamDetail);
    mocks.addMember.mockResolvedValue({});
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: '添加成员' }));
    const roleSelect = screen.getByLabelText('角色') as HTMLSelectElement;
    expect(roleSelect.value).toBe('developer');

    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: ' carol ' } });
    fireEvent.change(roleSelect, { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: '确认添加' }));

    await waitFor(() =>
      expect(mocks.addMember).toHaveBeenCalledWith({
        variables: { tenantId: 't2', username: 'carol', role: 'admin' },
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('成员已添加');
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalled());
  });

  it('添加成员未填登录名时本地拦截', () => {
    setupDetail(teamDetail);
    renderDetail();

    fireEvent.click(screen.getByRole('button', { name: '添加成员' }));
    fireEvent.click(screen.getByRole('button', { name: '确认添加' }));

    expect(screen.getByRole('alert').textContent).toContain('请输入成员登录名');
    expect(mocks.addMember).not.toHaveBeenCalled();
  });

  it('添加成员错误映射账号不存在 / 已是成员', async () => {
    setupDetail(teamDetail);
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: '添加成员' }));
    fireEvent.change(screen.getByLabelText('登录名'), { target: { value: 'nobody' } });

    mocks.addMember.mockRejectedValueOnce(new Error('ACCOUNT_NOT_FOUND'));
    fireEvent.click(screen.getByRole('button', { name: '确认添加' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('账号不存在'),
    );

    mocks.addMember.mockRejectedValueOnce(new Error('already a member'));
    fireEvent.click(screen.getByRole('button', { name: '确认添加' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('该账号已是租户成员'),
    );
  });

  it('移除成员需二次确认，确认后调用 adminRemoveTenantMember 并刷新', async () => {
    setupDetail(teamDetail);
    mocks.removeMember.mockResolvedValue({});
    renderDetail();

    const rowRemoveButtons = screen.getAllByRole('button', { name: '移除' });
    fireEvent.click(rowRemoveButtons[1]);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/确认将「bob」移出租户/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: '移除' }));

    await waitFor(() =>
      expect(mocks.removeMember).toHaveBeenCalledWith({
        variables: { tenantId: 't2', userId: 'u2' },
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('成员已移除');
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('last-admin 移除被服务端拒绝时给出明确提示', async () => {
    setupDetail(teamDetail);
    mocks.removeMember.mockRejectedValueOnce(new Error('LAST_ADMIN'));
    renderDetail();

    fireEvent.click(screen.getAllByRole('button', { name: '移除' })[0]);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '移除' }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        '该成员是租户最后一名管理员，无法移除（请先添加其他管理员）',
      ),
    );
    // 失败时保留确认框，便于管理员处理
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith('成员已移除');
  });

  it('变更角色以「移除 + 重新添加」完成并指定新角色', async () => {
    setupDetail(teamDetail);
    mocks.removeMember.mockResolvedValue({});
    mocks.addMember.mockResolvedValue({});
    renderDetail();

    fireEvent.click(screen.getAllByRole('button', { name: '变更角色' })[1]);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('成员会短暂失去访问权限');
    expect(dialog.textContent).toContain('级联清空该成员在本租户全部普通工作区的成员关系');
    expect(dialog.textContent).toContain('重新添加后不会自动恢复');
    const newRoleSelect = within(dialog).getByLabelText('新角色') as HTMLSelectElement;
    expect(newRoleSelect.value).toBe('developer');
    fireEvent.change(newRoleSelect, { target: { value: 'admin' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认变更' }));

    await waitFor(() =>
      expect(mocks.removeMember).toHaveBeenCalledWith({
        variables: { tenantId: 't2', userId: 'u2' },
      }),
    );
    await waitFor(() =>
      expect(mocks.addMember).toHaveBeenCalledWith({
        variables: { tenantId: 't2', username: 'bob', role: 'admin' },
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('角色已变更');
  });

  it('变更角色时 last-admin 保护提示（不执行移除后的重新添加）', async () => {
    setupDetail(teamDetail);
    mocks.removeMember.mockRejectedValueOnce(new Error('last admin cannot be removed'));
    renderDetail();

    fireEvent.click(screen.getAllByRole('button', { name: '变更角色' })[0]);
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('新角色'), { target: { value: 'developer' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认变更' }));

    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain(
        '最后一名管理员',
      ),
    );
    expect(mocks.addMember).not.toHaveBeenCalled();
  });
});
