import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TenantMembersPage from '../TenantMembersPage';
import type {
  TenantMembershipData,
  WorkspaceMemberData,
  WorkspaceTenantData,
} from '../../graphql/types';
import { resetWorkspaceStore, syncWorkspaceContext } from '../../stores/workspace';

const mockAdd = vi.fn();
const mockChangeRole = vi.fn();
const mockRemove = vi.fn();
const mockUseQuery = vi.fn();
const paramsState = vi.hoisted(() => ({ tenantId: 'tenant-t' }));

interface MutationDocument {
  definitions?: Array<{ name?: { value?: string } }>;
}

vi.mock('@apollo/client/react', () => ({
  useMutation: (document: MutationDocument) => {
    const name = document?.definitions?.[0]?.name?.value;
    if (name === 'AddTenantMember') return [mockAdd, { loading: false }];
    if (name === 'ChangeTenantMemberRole') return [mockChangeRole, { loading: false }];
    return [mockRemove, { loading: false }];
  },
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ tenantId: paramsState.tenantId }),
  useNavigate: () => vi.fn(),
}));

const TEAM: WorkspaceTenantData = {
  id: 'tenant-t',
  name: '团队一',
  type: 'team',
  memberCount: 2,
};
const PERSONAL: WorkspaceTenantData = {
  id: 'tenant-p',
  name: '张三',
  type: 'personal',
  memberCount: 1,
};

const MEMBERS: WorkspaceMemberData[] = [
  { id: 'u1', name: '管理员', username: 'admin1', role: 'admin', createdAt: '' },
  { id: 'u2', name: '开发甲', username: 'dev1', role: 'developer', createdAt: '' },
];

const TEAM_MEMBERSHIP: TenantMembershipData = { tenant: TEAM, role: 'admin' };

function mockQueries() {
  mockUseQuery.mockImplementation((query: { definitions?: Array<{ name?: { value?: string } }> }) => {
    const operationName = query?.definitions?.[0]?.name?.value;
    if (operationName === 'GetTenantMembers') {
      return { data: { tenantMembers: MEMBERS }, loading: false };
    }
    if (operationName === 'SearchAccounts') {
      return {
        data: {
          searchAccounts: [
            { username: 'newbie', name: '新人', userId: 'u3' },
          ],
        },
        loading: false,
      };
    }
    return { data: undefined, loading: false };
  });
}

function setMembership(membership: TenantMembershipData) {
  // 租户成员页通过 useWorkspaceStore.myTenants 判定权限
  window.localStorage.clear();
  resetWorkspaceStore();
  paramsState.tenantId = membership.tenant.id;
  syncWorkspaceContext({
    workspaces: [
      {
        id: 'ws-t',
        name: '全局工作区',
        type: 'global',
        tenant: membership.tenant,
        memberCount: membership.tenant.memberCount,
        myRole: membership.role,
        readOnly: false,
        createdAt: '',
      },
    ],
    tenants: [membership],
    userId: 'u1',
  });
}

describe('TenantMembersPage（仅 admin / last-admin 提示）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdd.mockReset();
    mockChangeRole.mockReset();
    mockRemove.mockReset();
    mockQueries();
  });

  it('admin 展示成员用户名/展示名/角色，并可搜索添加与变更角色', async () => {
    setMembership(TEAM_MEMBERSHIP);
    mockChangeRole.mockResolvedValue({ data: { changeTenantMemberRole: MEMBERS[1] } });
    render(<TenantMembersPage />);

    expect(screen.getByTestId('tenant-member-row-u1')).toHaveTextContent('管理员');
    expect(screen.getByTestId('tenant-member-row-u2')).toHaveTextContent('@dev1');
    expect(screen.getAllByText('开发').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('变更 dev1 的角色'), { target: { value: 'admin' } });
    await waitFor(() => {
      expect(mockChangeRole).toHaveBeenCalledWith({
        variables: { tenantId: 'tenant-t', userId: 'u2', role: 'admin' },
      });
    });

    fireEvent.change(screen.getByLabelText('搜索帐号'), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => {
      expect(screen.getByText('新人')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => {
      expect(mockAdd).toHaveBeenCalledWith({
        variables: { tenantId: 'tenant-t', username: 'newbie', role: 'developer' },
      });
    });
  });

  it('last-admin 降级被拒绝时展示明确提示', async () => {
    setMembership(TEAM_MEMBERSHIP);
    mockChangeRole.mockRejectedValue(new Error('last admin cannot be demoted'));
    render(<TenantMembersPage />);

    fireEvent.change(screen.getByLabelText('变更 admin1 的角色'), {
      target: { value: 'developer' },
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        '至少保留一名管理员，不能降级最后一名管理员',
      );
    });
  });

  it('developer 无入口：展示仅管理员提示', () => {
    setMembership({ tenant: TEAM, role: 'developer' });
    render(<TenantMembersPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('仅租户管理员可管理成员与角色');
    expect(screen.queryByLabelText('搜索帐号')).toBeNull();
  });

  it('personal 租户无成员管理入口', () => {
    setMembership({ tenant: PERSONAL, role: 'admin' });
    render(<TenantMembersPage />);
    expect(screen.getByText('个人租户仅有一名成员且恒为管理员，无成员管理入口。')).toBeInTheDocument();
  });
});
