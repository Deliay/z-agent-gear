import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import WorkspaceSwitcher from '../WorkspaceSwitcher';
import type {
  TenantMembershipData,
  WorkspaceData,
  WorkspaceTenantData,
} from '../../graphql/types';
import { resetWorkspaceStore, selectWorkspace, syncWorkspaceContext } from '../../stores/workspace';

const mockResetStore = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useApolloClient: () => ({ resetStore: mockResetStore }),
}));

vi.mock('react-router-dom', () => ({
  NavLink: ({ children, to, ...rest }: { children: React.ReactNode; to: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>{children}</a>
  ),
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
    memberCount: 1,
    myRole,
    readOnly: type === 'global' && myRole === 'developer',
    createdAt: '',
  };
}

const PERSONAL_GLOBAL = ws('ws-p', '全局工作区', 'global', PERSONAL, 'admin');
const TEAM_GLOBAL = ws('ws-tg', '全局工作区', 'global', TEAM, 'admin');
const TEAM_NORMAL = ws('ws-tn', '项目 A', 'normal', TEAM, 'admin');

const PERSONAL_MEMBERSHIP: TenantMembershipData = { tenant: PERSONAL, role: 'admin' };
const ADMIN_MEMBERSHIP: TenantMembershipData = { tenant: TEAM, role: 'admin' };
const DEV_MEMBERSHIP: TenantMembershipData = { tenant: TEAM, role: 'developer' };

function renderAs(
  workspaces: WorkspaceData[],
  tenants: TenantMembershipData[],
  currentId: string,
) {
  syncWorkspaceContext({ workspaces, tenants, userId: 'u1' });
  selectWorkspace(currentId);
  return render(<WorkspaceSwitcher />);
}

describe('WorkspaceSwitcher（按角色过滤）', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWorkspaceStore();
    vi.clearAllMocks();
  });

  it('个人用户（仅个人租户）不渲染切换器', () => {
    syncWorkspaceContext({
      workspaces: [PERSONAL_GLOBAL],
      tenants: [PERSONAL_MEMBERSHIP],
      userId: 'u1',
    });
    render(<WorkspaceSwitcher />);
    expect(screen.queryByTestId('workspace-switcher')).toBeNull();
  });

  it('admin 展示全部可见工作区、按租户分组与管理入口', () => {
    renderAs(
      [PERSONAL_GLOBAL, TEAM_GLOBAL, TEAM_NORMAL],
      [PERSONAL_MEMBERSHIP, ADMIN_MEMBERSHIP],
      'ws-tn',
    );

    expect(screen.getByTestId('workspace-switcher')).toBeInTheDocument();
    const select = screen.getByLabelText('切换工作区') as HTMLSelectElement;
    expect(select.value).toBe('ws-tn');
    expect(screen.getByRole('group', { name: '团队一（管理员）' })).toBeInTheDocument();
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '全局工作区（全局）',
      '全局工作区（全局）',
      '项目 A',
    ]);
    expect(screen.getByLabelText('工作区管理')).toBeInTheDocument();
    expect(screen.getByLabelText('租户成员')).toBeInTheDocument();
  });

  it('developer 无工作区管理/租户成员入口（仅保留自身可见工作区）', () => {
    const devGlobal = ws('ws-tg', '全局工作区', 'global', TEAM, 'developer');
    const devNormal = ws('ws-tn', '项目 A', 'normal', TEAM, 'developer');
    renderAs(
      [PERSONAL_GLOBAL, devGlobal, devNormal],
      [PERSONAL_MEMBERSHIP, DEV_MEMBERSHIP],
      'ws-tn',
    );

    expect(screen.getByTestId('workspace-switcher')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '团队一（开发）' })).toBeInTheDocument();
    expect(screen.queryByLabelText('工作区管理')).toBeNull();
    expect(screen.queryByLabelText('租户成员')).toBeNull();
  });
});
