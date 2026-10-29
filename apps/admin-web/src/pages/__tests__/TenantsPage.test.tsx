import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TenantsPage from '@/pages/TenantsPage';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  createFrontUser: vi.fn(),
  createTeamTenant: vi.fn(),
  refetch: vi.fn(),
  navigate: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: (document: unknown) => {
    const text = String(document);
    if (text.includes('adminCreateTeamTenant')) {
      return [mocks.createTeamTenant, { loading: false }];
    }
    return [mocks.createFrontUser, { loading: false }];
  },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn() },
}));

function tenant(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    name: 'alice',
    type: 'personal',
    memberCount: 1,
    balance: 100,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function setupTenants(tenants: unknown[]) {
  mocks.useQuery.mockReturnValue({
    data: { adminTenants: tenants },
    loading: false,
    error: undefined,
    refetch: mocks.refetch,
  });
}

function openTeamDialog() {
  fireEvent.click(screen.getByRole('button', { name: '创建团队租户' }));
}

describe('TenantsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染租户列表（名称/类型/成员数/余额/创建时间）且无编辑删除入口', () => {
    setupTenants([tenant(), tenant({ id: 't2', name: 'bob', balance: null, memberCount: 2 })]);
    render(<TenantsPage />);

    expect(screen.getByRole('heading', { name: '租户管理' })).toBeDefined();
    expect(screen.getByText('alice')).toBeDefined();
    expect(screen.getByText('100.00')).toBeDefined();
    expect(screen.getByText('-')).toBeDefined();
    expect(screen.getAllByText('个人').length).toBe(2);
    expect(screen.getByRole('button', { name: '开户' })).toBeDefined();
    // 只读：列表页没有任何编辑/删除/停用入口
    expect(screen.queryByRole('button', { name: /编辑|删除|停用/ })).toBeNull();
  });

  it('类型列区分个人租户与团队租户', () => {
    setupTenants([
      tenant(),
      tenant({ id: 't2', name: 'team-a', type: 'team', memberCount: 3 }),
    ]);
    render(<TenantsPage />);

    expect(screen.getByText('个人')).toBeDefined();
    expect(screen.getByText('团队')).toBeDefined();
    expect(screen.getByText('team-a')).toBeDefined();
  });

  it('按名称检索并重置页码', () => {
    setupTenants([tenant()]);
    render(<TenantsPage />);
    fireEvent.change(screen.getByLabelText('租户名称检索'), { target: { value: 'ali' } });

    const lastCall = mocks.useQuery.mock.calls.at(-1);
    expect(lastCall?.[1]).toEqual({
      variables: { keyword: 'ali', page: 1, pageSize: 20 },
    });
  });

  it('点击行进入租户详情', () => {
    setupTenants([tenant()]);
    render(<TenantsPage />);
    fireEvent.click(screen.getByText('alice'));
    expect(mocks.navigate).toHaveBeenCalledWith('/tenants/t1');
  });

  it('空列表展示空态', () => {
    setupTenants([]);
    render(<TenantsPage />);
    expect(screen.getByText('暂无租户')).toBeDefined();
  });

  it('开户表单本地校验用户名长度 2-20', () => {
    setupTenants([]);
    render(<TenantsPage />);
    fireEvent.click(screen.getByRole('button', { name: '开户' }));
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('初始密码'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '确认开户' }));

    expect(screen.getByRole('alert').textContent).toContain('用户名长度需为 2-20 个字符');
    expect(mocks.createFrontUser).not.toHaveBeenCalled();
  });

  it('开户表单本地校验密码至少 6 位', () => {
    setupTenants([]);
    render(<TenantsPage />);
    fireEvent.click(screen.getByRole('button', { name: '开户' }));
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('初始密码'), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: '确认开户' }));

    expect(screen.getByRole('alert').textContent).toContain('密码至少 6 位');
    expect(mocks.createFrontUser).not.toHaveBeenCalled();
  });

  it('开户成功调用 adminCreateFrontUser 并刷新列表', async () => {
    setupTenants([]);
    mocks.createFrontUser.mockResolvedValue({});
    render(<TenantsPage />);
    fireEvent.click(screen.getByRole('button', { name: '开户' }));
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: ' alice ' } });
    fireEvent.change(screen.getByLabelText('初始密码'), { target: { value: 'secret1' } });
    fireEvent.click(screen.getByRole('button', { name: '确认开户' }));

    await waitFor(() =>
      expect(mocks.createFrontUser).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: { username: 'alice', password: 'secret1' },
        }),
      ),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('开户成功');
  });

  it('开户错误映射重名 / 非法 / 服务不可用', async () => {
    setupTenants([]);
    render(<TenantsPage />);
    fireEvent.click(screen.getByRole('button', { name: '开户' }));
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('初始密码'), { target: { value: 'secret1' } });

    mocks.createFrontUser.mockRejectedValueOnce(new Error('Username already taken'));
    fireEvent.click(screen.getByRole('button', { name: '确认开户' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('用户名已被占用'));

    mocks.createFrontUser.mockRejectedValueOnce(new Error('Username must be between 2 and 20 characters'));
    fireEvent.click(screen.getByRole('button', { name: '确认开户' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('用户名长度需为 2-20 个字符'),
    );

    mocks.createFrontUser.mockRejectedValueOnce(new Error('AGENT_API_UNAVAILABLE'));
    fireEvent.click(screen.getByRole('button', { name: '确认开户' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('AGENT_API_UNAVAILABLE'),
    );
  });

  it('创建团队租户表单本地校验名称非空且不超过 60 字符', () => {
    setupTenants([]);
    render(<TenantsPage />);
    openTeamDialog();

    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    expect(screen.getByRole('alert').textContent).toContain('租户名称长度需为 1-60 个字符');
    expect(mocks.createTeamTenant).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('租户名称'), { target: { value: 'x'.repeat(61) } });
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    expect(screen.getByRole('alert').textContent).toContain('租户名称长度需为 1-60 个字符');
    expect(mocks.createTeamTenant).not.toHaveBeenCalled();
  });

  it('创建团队租户成功调用 adminCreateTeamTenant（trim 名称）并刷新列表', async () => {
    setupTenants([]);
    mocks.createTeamTenant.mockResolvedValue({});
    render(<TenantsPage />);
    openTeamDialog();
    fireEvent.change(screen.getByLabelText('租户名称'), { target: { value: ' 产品组 ' } });
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));

    await waitFor(() =>
      expect(mocks.createTeamTenant).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: { name: '产品组' },
          refetchQueries: [expect.any(String)],
        }),
      ),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('团队租户创建成功');
    await waitFor(() => expect(screen.queryByLabelText('租户名称')).toBeNull());
  });

  it('创建团队租户错误映射重名 / 非法 / 服务不可用', async () => {
    setupTenants([]);
    render(<TenantsPage />);
    openTeamDialog();
    fireEvent.change(screen.getByLabelText('租户名称'), { target: { value: '产品组' } });

    mocks.createTeamTenant.mockRejectedValueOnce(new Error('TENANT_NAME_TAKEN'));
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('租户名称已存在'));

    mocks.createTeamTenant.mockRejectedValueOnce(new Error('INVALID_BODY'));
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('租户名称长度需为 1-60 个字符'),
    );

    mocks.createTeamTenant.mockRejectedValueOnce(new Error('AGENT_API_UNAVAILABLE'));
    fireEvent.click(screen.getByRole('button', { name: '确认创建' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('AGENT_API_UNAVAILABLE'),
    );

    // 失败后弹窗保留，便于修正后重试
    expect(screen.getByLabelText('租户名称')).toBeDefined();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
