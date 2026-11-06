import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Mock } from 'vitest';
import { print } from 'graphql';
import ValutSection from '../ValutSection';
import { GET_VALUT_ENTRIES, GET_VALUT_MANUAL_OPTIONS } from '@/graphql/queries';
import type { ValutEntryData, ValutNamespaceGroupData, WorkspaceData, WorkspaceTenantData } from '@/graphql/types';
import { resetWorkspaceStore, selectWorkspace, syncWorkspaceContext } from '@/stores/workspace';

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  navigate: vi.fn(),
}));

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockCreateValutEntry = vi.fn();
const mockUpdateValutEntry = vi.fn();
const mockDeleteValutEntry = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [mocks.searchParams],
  useNavigate: () => mocks.navigate,
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

const TEAM: WorkspaceTenantData = { id: 't1', name: '团队一', type: 'team', memberCount: 2 };

const WRITABLE: WorkspaceData = {
  id: 'ws-1',
  name: '项目 A',
  type: 'normal',
  tenant: TEAM,
  memberCount: 1,
  myRole: 'admin',
  readOnly: false,
  createdAt: '',
};

const READONLY_GLOBAL: WorkspaceData = {
  id: 'ws-global',
  name: '全局工作区',
  type: 'global',
  tenant: TEAM,
  memberCount: 2,
  myRole: 'developer',
  readOnly: true,
  createdAt: '',
};

function setupWorkspace(workspace: WorkspaceData) {
  syncWorkspaceContext({
    workspaces: [workspace],
    tenants: [{ tenant: workspace.tenant, role: workspace.myRole }],
    userId: 'u1',
  });
  selectWorkspace(workspace.id);
}

function makeEntry(overrides: Partial<ValutEntryData> = {}): ValutEntryData {
  return {
    id: 'e1',
    namespace: 'manual',
    namespaceDisplayName: '自定义密钥',
    key: 'api-token',
    editable: true,
    deletable: true,
    refs: [],
    createdBy: 'alice',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z',
    ...overrides,
  };
}

const MANUAL_GROUP: ValutNamespaceGroupData = {
  namespace: { name: 'manual', displayName: '自定义密钥', managed: false },
  entries: [
    makeEntry(),
    makeEntry({
      id: 'e2',
      key: 'linked-token',
      refs: [
        {
          feature: 'mcp-bearer-tokens',
          refId: 'cmcp-1',
          refLabel: 'MCP A',
          createdAt: '2026-11-03T00:00:00Z',
        },
      ],
    }),
  ],
};

const SERVICE_GROUP: ValutNamespaceGroupData = {
  namespace: { name: 'service-mcp-bearer-tokens', displayName: 'MCP Bearer Tokens', managed: true },
  entries: [
    makeEntry({
      id: 'e3',
      namespace: 'service-mcp-bearer-tokens',
      namespaceDisplayName: 'MCP Bearer Tokens',
      key: 'MCP A',
      deletable: false,
      refs: [
        {
          feature: 'mcp-bearer-tokens',
          refId: 'cmcp-1',
          refLabel: 'MCP A',
          createdAt: '2026-11-03T00:00:00Z',
        },
      ],
    }),
  ],
};

function mockQueries(groups: ValutNamespaceGroupData[] = [MANUAL_GROUP, SERVICE_GROUP]) {
  mockUseQuery.mockImplementation((query: { definitions?: Array<{ name?: { value?: string } }> }) => {
    const operationName = query?.definitions?.[0]?.name?.value;
    if (operationName === 'GetValutEntries') {
      return { data: { valutEntries: groups }, loading: false, error: null, refetch: vi.fn() };
    }
    return { data: { valutManualOptions: [] }, loading: false, error: null, refetch: vi.fn() };
  });
}

function mockMutations() {
  mockUseMutation.mockImplementation((query: { definitions?: Array<{ name?: { value?: string } }> }) => {
    const operationName = query?.definitions?.[0]?.name?.value;
    if (operationName === 'CreateValutEntry') return [mockCreateValutEntry, { loading: false }];
    if (operationName === 'UpdateValutEntry') return [mockUpdateValutEntry, { loading: false }];
    if (operationName === 'DeleteValutEntry') return [mockDeleteValutEntry, { loading: false }];
    return [vi.fn(), { loading: false }];
  });
}

async function openEditDialog(entryKey: string) {
  fireEvent.click(screen.getByRole('button', { name: `编辑 ${entryKey}` }));
  return await screen.findByRole('dialog');
}

describe('ValutSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetWorkspaceStore();
    mocks.searchParams = new URLSearchParams();
    setupWorkspace(WRITABLE);
    mockQueries();
    mockMutations();
    mockCreateValutEntry.mockResolvedValue({ data: { createValutEntry: makeEntry() } });
    mockUpdateValutEntry.mockResolvedValue({ data: { updateValutEntry: makeEntry() } });
    mockDeleteValutEntry.mockResolvedValue({ data: { deleteValutEntry: true } });
    // vitest.setup 已兜底为 no-op；这里换成可断言的 spy（先例 MessageList.test）
    Element.prototype.scrollIntoView = vi.fn();
  });

  function scrollSpy(): Mock {
    return Element.prototype.scrollIntoView as unknown as Mock;
  }

  // T-WEB1：聚合渲染 + 无 value 出参
  describe('T-WEB1 聚合展示与明文边界', () => {
    it('标题带「工作区」badge，按 namespace 聚合并展示组头 displayName', () => {
      render(<ValutSection />);

      expect(screen.getByRole('heading', { name: 'Valut' })).toBeInTheDocument();
      expect(screen.getByText('工作区')).toBeInTheDocument();
      expect(screen.getByTestId('valut-group-manual')).toHaveTextContent('自定义密钥');
      expect(screen.getByTestId('valut-group-service-mcp-bearer-tokens')).toHaveTextContent(
        'MCP Bearer Tokens',
      );
      expect(screen.getByText('api-token')).toBeInTheDocument();
      expect(screen.getByText('MCP A')).toBeInTheDocument();
    });

    it('GET_VALUT_ENTRIES / GET_VALUT_MANUAL_OPTIONS 选择集不含 value 字段（安全红线）', () => {
      render(<ValutSection />);

      expect(print(GET_VALUT_ENTRIES)).not.toMatch(/\bvalue\b/);
      expect(print(GET_VALUT_MANUAL_OPTIONS)).not.toMatch(/\bvalue\b/);
      // 界面上不存在任何明文值展示
      expect(screen.getByTestId('valut-section')).not.toHaveTextContent('super-secret');
    });

    it('空态展示「暂无密钥条目」', () => {
      mockQueries([]);
      render(<ValutSection />);

      expect(screen.getByText('暂无密钥条目')).toBeInTheDocument();
    });
  });

  // T-WEB1：新增
  describe('T-WEB1 新增条目', () => {
    it('新增对话框 key 单行、value 多行，提交 createValutEntry', async () => {
      render(<ValutSection />);
      fireEvent.click(screen.getByRole('button', { name: '新增条目' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('heading', { name: '新增条目' })).toBeInTheDocument();

      const keyInput = within(dialog).getByLabelText('名称') as HTMLInputElement;
      expect(keyInput.tagName).toBe('INPUT');

      const valueInput = within(dialog).getByLabelText('值') as HTMLTextAreaElement;
      expect(valueInput.tagName).toBe('TEXTAREA');

      fireEvent.change(keyInput, { target: { value: '  new-key  ' } });
      fireEvent.change(valueInput, { target: { value: 'plain-value' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

      await waitFor(() => {
        expect(mockCreateValutEntry).toHaveBeenCalledWith({
          variables: { input: { key: 'new-key', value: 'plain-value' } },
        });
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('密钥条目已创建');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('key/value 为空时本地拦截且不发请求', async () => {
      render(<ValutSection />);
      fireEvent.click(screen.getByRole('button', { name: '新增条目' }));
      const dialog = await screen.findByRole('dialog');

      fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('请输入密钥名称');
      expect(mockCreateValutEntry).not.toHaveBeenCalled();
    });

    it('服务端 valut key already exists 映射为中文提示且对话框保持打开', async () => {
      mockCreateValutEntry.mockRejectedValueOnce(new Error('valut key already exists'));
      render(<ValutSection />);
      fireEvent.click(screen.getByRole('button', { name: '新增条目' }));
      const dialog = await screen.findByRole('dialog');

      fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: 'dup' } });
      fireEvent.change(within(dialog).getByLabelText('值'), { target: { value: 'v' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('该密钥名称已存在');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  // T-WEB1：编辑（D10）
  describe('T-WEB1 编辑不回显旧值', () => {
    it('编辑对话框 key 只读、value 为空且 placeholder 要求重填', async () => {
      render(<ValutSection />);
      const dialog = await openEditDialog('api-token');

      expect(within(dialog).getByRole('heading', { name: '编辑条目' })).toBeInTheDocument();
      const keyInput = within(dialog).getByLabelText('名称') as HTMLInputElement;
      expect(keyInput).toHaveValue('api-token');
      expect(keyInput).toHaveAttribute('readonly');

      const valueInput = within(dialog).getByLabelText('值') as HTMLTextAreaElement;
      expect(valueInput).toHaveValue('');
      expect(valueInput).toHaveAttribute('placeholder', '输入新值（旧值不可见）');
    });

    it('提交 updateValutEntry(id, value) 且只带新值', async () => {
      render(<ValutSection />);
      const dialog = await openEditDialog('api-token');

      fireEvent.change(within(dialog).getByLabelText('值'), { target: { value: 'rotated-value' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

      await waitFor(() => {
        expect(mockUpdateValutEntry).toHaveBeenCalledWith({
          variables: { id: 'e1', value: 'rotated-value' },
        });
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('密钥值已更新');
    });

    it('未填新值时拦截提交', async () => {
      render(<ValutSection />);
      const dialog = await openEditDialog('api-token');

      fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('请输入密钥值');
      expect(mockUpdateValutEntry).not.toHaveBeenCalled();
    });
  });

  // T-WEB1：删除收敛 + refs
  describe('T-WEB1 删除收敛与 refs 展开', () => {
    it('deletable=false 的 service-* 条目无删除入口', () => {
      render(<ValutSection />);

      expect(screen.getByRole('button', { name: '编辑 MCP A' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '删除 MCP A' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '删除 api-token' })).toBeInTheDocument();
    });

    it('删除走二次确认并提交 deleteValutEntry', async () => {
      render(<ValutSection />);
      fireEvent.click(screen.getByRole('button', { name: '删除 api-token' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('heading', { name: '删除密钥条目' })).toBeInTheDocument();
      expect(within(dialog).getByText(/确定删除密钥「api-token」吗/)).toBeInTheDocument();

      fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));

      await waitFor(() => {
        expect(mockDeleteValutEntry).toHaveBeenCalledWith({ variables: { id: 'e1' } });
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('密钥条目已删除');
    });

    it('refs 展开可见 refLabel 与 feature', () => {
      render(<ValutSection />);
      const row = screen.getByTestId('valut-entry-e2');
      expect(row).not.toHaveTextContent('mcp-bearer-tokens');

      fireEvent.click(screen.getByRole('button', { name: '查看 linked-token 的引用' }));

      expect(row).toHaveTextContent('MCP A');
      expect(row).toHaveTextContent('mcp-bearer-tokens');
    });
  });

  // T-WEB1：只读收敛（全局工作区 developer）
  describe('T-WEB1 只读收敛', () => {
    it('全局工作区 + developer 隐藏新增/编辑/删除入口但保留列表', () => {
      setupWorkspace(READONLY_GLOBAL);
      render(<ValutSection />);

      expect(screen.getByText('api-token')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '新增条目' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '编辑 api-token' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '删除 api-token' })).not.toBeInTheDocument();
      expect(screen.getByText('密钥值仅创建/编辑时填写，界面不展示')).toBeInTheDocument();
    });
  });

  // T-WEB1：D11 穿透定位
  describe('T-WEB1 searchParams 穿透定位', () => {
    it('section=valut 滚动到区块，entry 命中自动展开编辑对话框', async () => {
      mocks.searchParams = new URLSearchParams('section=valut&entry=e1');
      render(<ValutSection />);

      await waitFor(() => {
        expect(scrollSpy()).toHaveBeenCalledWith({ behavior: 'smooth' });
      });

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('heading', { name: '编辑条目' })).toBeInTheDocument();
      expect(within(dialog).getByLabelText('名称')).toHaveValue('api-token');
      expect(within(dialog).getByLabelText('值')).toHaveValue('');
    });

    it('只带 section=valut 时滚动到区块但不弹窗', async () => {
      mocks.searchParams = new URLSearchParams('section=valut');
      render(<ValutSection />);

      await waitFor(() => {
        expect(scrollSpy()).toHaveBeenCalledWith({ behavior: 'smooth' });
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('只读上下文穿透时只滚动不弹窗（无编辑入口）', async () => {
      setupWorkspace(READONLY_GLOBAL);
      mocks.searchParams = new URLSearchParams('section=valut&entry=e1');
      render(<ValutSection />);

      await waitFor(() => {
        expect(scrollSpy()).toHaveBeenCalledWith({ behavior: 'smooth' });
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('未带穿透参数时既不滚动也不弹窗', () => {
      render(<ValutSection />);

      expect(scrollSpy()).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
