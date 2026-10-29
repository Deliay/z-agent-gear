import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProviderSection from '../ProviderSection';
import type { WorkspaceData, WorkspaceTenantData } from '@/graphql/types';
import { resetWorkspaceStore, selectWorkspace, syncWorkspaceContext } from '@/stores/workspace';

const mockUseQuery = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [vi.fn(), { loading: false }],
}));

const TEAM: WorkspaceTenantData = { id: 't1', name: '团队一', type: 'team', memberCount: 2 };

const GLOBAL: WorkspaceData = {
  id: 'ws-global',
  name: '全局工作区',
  type: 'global',
  tenant: TEAM,
  memberCount: 2,
  myRole: 'admin',
  readOnly: false,
  createdAt: '',
};
const NORMAL: WorkspaceData = {
  id: 'ws-normal',
  name: '项目 A',
  type: 'normal',
  tenant: TEAM,
  memberCount: 1,
  myRole: 'admin',
  readOnly: false,
  createdAt: '',
};
const READONLY_GLOBAL: WorkspaceData = {
  ...GLOBAL,
  myRole: 'developer',
  readOnly: true,
};

const SHARED_PROVIDER = {
  id: 'p1',
  name: '共享供应商',
  type: 'openai',
  endpoint: 'https://api.example',
  credentialType: 'api_key',
  credentialValue: 'sk-xxx',
  isEnabled: true,
  scope: 'user' as const,
  workspaceId: 'ws-global',
  models: [],
  createdAt: '',
  updatedAt: '',
};

function setup(workspaces: WorkspaceData[], currentId: string) {
  syncWorkspaceContext({
    workspaces,
    tenants: [{ tenant: TEAM, role: workspaces[0].myRole }],
    userId: 'u1',
  });
  selectWorkspace(currentId);
}

describe('ProviderSection 来源徽标与只读收敛', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWorkspaceStore();
    mockUseQuery.mockReturnValue({
      data: { providers: [SHARED_PROVIDER] },
      loading: false,
    });
  });

  it('普通工作区上下文中的全局工作区供应商：展示来源徽标且隐藏编辑/删除入口', async () => {
    setup([GLOBAL, NORMAL], NORMAL.id);
    render(<ProviderSection />);

    expect(screen.getByText('共享供应商')).toBeInTheDocument();
    expect(screen.getByTestId('resource-source-badge')).toHaveTextContent('全局工作区');
    expect(screen.queryByLabelText('操作菜单')).toBeNull();
    // 普通上下文仍可添加本工作区供应商
    expect(screen.getByRole('button', { name: '添加供应商' })).toBeInTheDocument();
  });

  it('全局工作区 + developer：整体只读，隐藏添加与编辑入口', async () => {
    setup([READONLY_GLOBAL], READONLY_GLOBAL.id);
    render(<ProviderSection />);

    expect(screen.getByText('全局工作区对开发者只读')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加供应商' })).toBeNull();
    expect(screen.queryByLabelText('操作菜单')).toBeNull();
    // 本工作区资源在只读上下文同样不可编辑
    expect(screen.getByTestId('resource-source-badge')).toHaveTextContent('本工作区');
  });
});
