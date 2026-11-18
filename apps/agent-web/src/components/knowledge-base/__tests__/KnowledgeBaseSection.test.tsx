import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Mock } from 'vitest';
import KnowledgeBaseSection from '../KnowledgeBaseSection';
import type { KnowledgeBaseData, KnowledgeBaseTreeItemData } from '@/graphql/knowledge-base';
import type { WorkspaceData, WorkspaceTenantData } from '@/graphql/types';
import { resetWorkspaceStore, selectWorkspace, syncWorkspaceContext } from '@/stores/workspace';

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockMutate = vi.fn();
const mockNavigate = vi.fn();
const mockToastError = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useApolloClient: () => ({
    cache: { evict: vi.fn() },
    query: vi.fn().mockResolvedValue({}),
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => mockToastError(...args) },
}));

vi.mock('@/lib/knowledge-base-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/knowledge-base-path')>();
  return { ...actual, newDocumentName: () => '新文档-test' };
});

const TEAM: WorkspaceTenantData = { id: 't1', name: '团队一', type: 'team', memberCount: 2 };

function workspace(role: 'admin' | 'developer', readOnly = false): WorkspaceData {
  return {
    id: 'ws-1',
    name: '项目 A',
    type: 'normal',
    tenant: TEAM,
    memberCount: 1,
    myRole: role,
    readOnly,
    createdAt: '',
  };
}

function setupWorkspace(role: 'admin' | 'developer') {
  const ws = workspace(role);
  syncWorkspaceContext({
    workspaces: [ws],
    tenants: [{ tenant: TEAM, role }],
    userId: 'u1',
  });
  selectWorkspace(ws.id);
}

function makeAccess(overrides: Partial<KnowledgeBaseData['myAccess']> = {}): KnowledgeBaseData['myAccess'] {
  return {
    canRead: true,
    canCreate: true,
    canUpdate: true,
    canDelete: true,
    canManage: true,
    ...overrides,
  };
}

function makeTreeItem(
  overrides: {
    knowledgeBase?: Partial<KnowledgeBaseData>;
    documents?: KnowledgeBaseTreeItemData['documents'];
  } = {},
): KnowledgeBaseTreeItemData {
  return {
    knowledgeBase: {
      id: 'kb-1',
      name: '开发规范',
      permissionMode: 'FULL_ACCESS',
      global: true,
      myAccess: makeAccess(),
      createdAt: '',
      updatedAt: '',
      ...overrides.knowledgeBase,
    },
    documents: overrides.documents ?? [
      { path: '/a', title: 'A 文档', tags: ['tag'], description: '', updatedAt: '' },
      { path: '/a/b', title: 'B 文档', tags: [], description: '', updatedAt: '' },
    ],
  };
}

function mockTree(items: KnowledgeBaseTreeItemData[]) {
  mockUseQuery.mockImplementation((query: unknown) => {
    const name = (
      query as { definitions?: Array<{ name?: { value?: string } }> }
    )?.definitions?.[0]?.name?.value;
    if (name === 'GetRepoKnowledgeBaseHosts') {
      return { ...hostsResult, refetch: mockHostsRefetch };
    }
    return { data: { knowledgeBaseTree: items }, loading: false, refetch: vi.fn() };
  });
}

let hostsResult: { data?: unknown; loading?: boolean; error?: unknown } = {
  data: { repoKnowledgeBaseHosts: [] },
  loading: false,
};
const mockHostsRefetch = vi.fn();

function mockHosts(
  hosts: Array<{ cloudHostId: string; cloudHostName: string; workspaceId: string; scanSupported: boolean }>,
  extra: { loading?: boolean; error?: unknown; withData?: boolean } = {},
) {
  hostsResult = {
    data: extra.withData === false ? undefined : { repoKnowledgeBaseHosts: hosts },
    loading: extra.loading ?? false,
    error: extra.error,
  };
}

function renderSection() {
  return render(<KnowledgeBaseSection expanded onToggle={() => {}} />);
}

describe('KnowledgeBaseSection（T-KBW1~4）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetWorkspaceStore();
    mockUseMutation.mockReturnValue([mockMutate, { loading: false }]);
    mockMutate.mockResolvedValue({ data: {} });
    mockHosts([]);
    mockTree([makeTreeItem()]);
  });

  it('T-KBW1 非管理员不渲染分区「+」创建入口，树正常展示', () => {
    setupWorkspace('developer');
    mockTree([makeTreeItem({ knowledgeBase: { myAccess: makeAccess({ canManage: false }) } })]);
    renderSection();

    expect(screen.getByTestId('sidebar-section-knowledgeBases')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新建知识库' })).not.toBeInTheDocument();
    expect(screen.getByText('开发规范')).toBeInTheDocument();
  });

  it('T-KBW2 管理员可见分区「+」并打开创建对话框', () => {
    setupWorkspace('admin');
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: '新建知识库' }));
    expect(screen.getByTestId('create-knowledge-base-dialog')).toBeInTheDocument();
  });

  it('T-KBW3 树展示知识库 → 文档层级、文档标题与全局来源徽标', () => {
    setupWorkspace('admin');
    renderSection();

    expect(screen.getByText('开发规范')).toBeInTheDocument();
    expect(screen.getByText('A 文档')).toBeInTheDocument();
    expect(screen.getByText('B 文档')).toBeInTheDocument();
    expect(screen.getByTestId('knowledge-base-global-badge')).toHaveTextContent('全局');

    fireEvent.click(screen.getByText('B 文档'));
    expect(mockNavigate).toHaveBeenCalledWith('/knowledge-bases/kb-1/a/b');
  });

  it('T-KBW4 文档条目「+」持久化子文档并跳转编辑模式', async () => {
    setupWorkspace('admin');
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: '在 A 文档 下新建文档' }));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: {
          knowledgeBaseId: 'kb-1',
          path: '/a/新文档-test',
          input: { title: '新文档-test', tags: [], description: '', content: '' },
        },
      }),
    );
    const call = (mockMutate as Mock).mock.calls[0][0] as { refetchQueries: unknown[] };
    expect(call.refetchQueries).toHaveLength(1);
    await vi.waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.stringMatching(/^\/knowledge-bases\/kb-1\/a\/.*\?edit=1$/),
      );
    });
  });

  it('T-KBW4b 创建子文档失败时 toast 映射错误且不跳转', async () => {
    setupWorkspace('admin');
    mockMutate.mockRejectedValue(new Error('knowledge base permission denied'));
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: '在 A 文档 下新建文档' }));

    await vi.waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('没有执行该操作的权限');
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('T-RKB2-WEB1 平台库空 + hosts 非空 → 不出现「暂无知识库」，仓库分组正常展示', () => {
    setupWorkspace('admin');
    mockHosts([
      { cloudHostId: 'h1', cloudHostName: '云电脑一', workspaceId: 'ws-1', scanSupported: true },
    ]);
    mockTree([]);
    renderSection();

    expect(screen.queryByText('暂无知识库')).not.toBeInTheDocument();
    expect(screen.getByTestId('repo-knowledge-base-section')).toBeInTheDocument();
    expect(screen.getByText('云电脑一')).toBeInTheDocument();
  });

  it('T-RKB2-WEB2 平台库空 + hosts 已定态为空 → 出现「暂无知识库」', () => {
    setupWorkspace('admin');
    mockHosts([]);
    mockTree([]);
    renderSection();

    expect(screen.getAllByText('暂无知识库').length).toBeGreaterThan(0);
  });

  it('T-RKB2-WEB3 hosts 在途 → 不出现空态（展示加载中）；hosts 失败 → 不出现空态、展示失败与重试', () => {
    setupWorkspace('admin');
    mockHosts([], { loading: true, withData: false });
    mockTree([]);
    const { rerender } = renderSection();

    expect(screen.queryByText('暂无知识库')).not.toBeInTheDocument();
    expect(screen.getByText('加载中…')).toBeInTheDocument();

    hostsResult = { data: undefined, loading: false, error: new Error('boom') };
    rerender(<KnowledgeBaseSection expanded onToggle={() => {}} />);
    expect(screen.queryByText('暂无知识库')).not.toBeInTheDocument();
    expect(screen.getByText('加载失败')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('repo-kb-retry'));
    expect(mockHostsRefetch).toHaveBeenCalled();
  });
});
