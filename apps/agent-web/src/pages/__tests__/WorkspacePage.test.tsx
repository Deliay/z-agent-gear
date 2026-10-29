import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import WorkspacePage from '../WorkspacePage';
import type {
  TenantMembershipData,
  WorkspaceData,
  WorkspaceTenantData,
} from '../../graphql/types';
import { resetWorkspaceStore, selectWorkspace, syncWorkspaceContext } from '../../stores/workspace';

const mockCreate = vi.fn();
const mockUseQuery = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: () => [mockCreate, { loading: false }],
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useApolloClient: () => ({ resetStore: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  NavLink: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const PERSONAL: WorkspaceTenantData = {
  id: 'tenant-p',
  name: '张三',
  type: 'personal',
  memberCount: 1,
};
const TEAM: WorkspaceTenantData = {
  id: 'tenant-t',
  name: '团队一',
  type: 'team',
  memberCount: 3,
};

function ws(
  id: string,
  name: string,
  type: 'global' | 'normal',
  tenant: WorkspaceTenantData,
  myRole: 'admin' | 'developer',
): WorkspaceData {
  return {
    id,
    name,
    type,
    tenant,
    memberCount: 2,
    myRole,
    readOnly: type === 'global' && myRole === 'developer',
    createdAt: '',
  };
}

const PERSONAL_GLOBAL = ws('ws-p', '全局工作区', 'global', PERSONAL, 'admin');
const TEAM_GLOBAL = ws('ws-tg', '全局工作区', 'global', TEAM, 'admin');
const TEAM_NORMAL = ws('ws-tn', '项目 A', 'normal', TEAM, 'admin');

const MEMBERSHIPS: TenantMembershipData[] = [
  { tenant: PERSONAL, role: 'admin' },
  { tenant: TEAM, role: 'admin' },
];

function setup(
  workspaces: WorkspaceData[],
  tenants: TenantMembershipData[],
  currentId: string,
) {
  syncWorkspaceContext({ workspaces, tenants, userId: 'u1' });
  selectWorkspace(currentId);
}

describe('WorkspacePage（仅 admin 可操作）', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWorkspaceStore();
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue({ data: undefined, loading: false });
  });

  it('team admin 展示工作区列表、类型与成员数，并可创建/改名/删除/成员管理', () => {
    setup(
      [PERSONAL_GLOBAL, TEAM_GLOBAL, TEAM_NORMAL],
      MEMBERSHIPS,
      'ws-tn',
    );
    render(<WorkspacePage />);

    expect(screen.getAllByText('工作区管理').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '新建工作区' })).toBeInTheDocument();
    expect(screen.getByTestId('workspace-row-ws-tn')).toBeInTheDocument();
    expect(screen.getByText('项目 A')).toBeInTheDocument();
    expect(within(screen.getByTestId('workspace-row-ws-tn')).getByText('2 位成员')).toBeInTheDocument();

    // 全局工作区不可改名/删除/成员管理
    expect(screen.queryByTestId('workspace-row-ws-tg')).toBeInTheDocument();
    const globalRow = screen.getByTestId('workspace-row-ws-tg');
    expect(globalRow.textContent).toContain('全局工作区');
    expect(globalRow.querySelectorAll('button')).toHaveLength(0);

    const normalRow = screen.getByTestId('workspace-row-ws-tn');
    expect(normalRow.textContent).toContain('改名');
    expect(normalRow.textContent).toContain('成员');
    expect(normalRow.textContent).toContain('删除');
  });

  it('developer 无入口：展示仅管理员提示，不渲染列表操作', () => {
    const devNormal = ws('ws-tn', '项目 A', 'normal', TEAM, 'developer');
    setup(
      [PERSONAL_GLOBAL, devNormal],
      [{ tenant: PERSONAL, role: 'admin' }, { tenant: TEAM, role: 'developer' }],
      'ws-tn',
    );
    render(<WorkspacePage />);

    expect(screen.getByRole('alert')).toHaveTextContent('仅租户管理员可访问工作区管理');
    expect(screen.queryByRole('button', { name: '新建工作区' })).toBeNull();
    expect(screen.queryByTestId('workspace-row-ws-tn')).toBeNull();
  });

  it('个人租户仅有全局工作区：展示无管理入口提示', () => {
    setup([PERSONAL_GLOBAL], [{ tenant: PERSONAL, role: 'admin' }], 'ws-p');
    render(<WorkspacePage />);

    expect(screen.getByText('个人租户仅有全局工作区，无工作区管理入口。')).toBeInTheDocument();
  });

  it('重名创建错误映射为中文提示', async () => {
    setup([PERSONAL_GLOBAL, TEAM_GLOBAL], MEMBERSHIPS, 'ws-tg');
    mockCreate.mockRejectedValue(new Error('workspace name already exists'));
    render(<WorkspacePage />);

    fireEvent.click(screen.getByRole('button', { name: '新建工作区' }));
    fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: '重复名' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('工作区名称已存在');
    });
    expect(mockCreate).toHaveBeenCalledWith({ variables: { name: '重复名' } });
  });
});
