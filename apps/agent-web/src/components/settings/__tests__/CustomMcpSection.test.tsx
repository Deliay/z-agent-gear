import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import CustomMcpSection from '../CustomMcpSection';
import type {
  CustomMcpServerData,
  WorkspaceData,
  WorkspaceTenantData,
} from '@/graphql/types';
import { resetWorkspaceStore, selectWorkspace, syncWorkspaceContext } from '@/stores/workspace';

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockCreateCustomMcpServer = vi.fn();
const mockUpdateCustomMcpServer = vi.fn();
const mockDeleteCustomMcpServer = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock('react-router-dom', () => ({
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

function makeServer(overrides: Partial<CustomMcpServerData> = {}): CustomMcpServerData {
  return {
    id: 'cmcp-1',
    name: '内部文档 MCP',
    description: '内部文档服务',
    endpoint: 'https://mcp.example.com/sse',
    authType: 'none',
    customHeaders: [],
    bearerEntryId: null,
    bearerEntryManaged: null,
    workspaceId: 'ws-1',
    createdBy: 'alice',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z',
    ...overrides,
  };
}

const MANAGED_BEARER = makeServer({
  id: 'cmcp-2',
  name: '托管 Bearer MCP',
  endpoint: 'https://managed.example.com/mcp',
  authType: 'bearer',
  bearerEntryId: 'sv-1',
  bearerEntryManaged: true,
});

const REFERENCED_BEARER = makeServer({
  id: 'cmcp-3',
  name: '引用 Bearer MCP',
  endpoint: 'https://referenced.example.com/mcp',
  authType: 'bearer',
  bearerEntryId: 'mv-1',
  bearerEntryManaged: false,
});

function mockQueries(servers: CustomMcpServerData[] = []) {
  mockUseQuery.mockImplementation((query: { definitions?: Array<{ name?: { value?: string } }> }) => {
    const operationName = query?.definitions?.[0]?.name?.value;
    if (operationName === 'GetCustomMcpServers') {
      return { data: { customMcpServers: servers }, loading: false, error: null, refetch: vi.fn() };
    }
    return {
      data: {
        valutManualOptions: [
          makeManualOption('mv-1', 'manual-token-a'),
          makeManualOption('mv-2', 'manual-token-b'),
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    };
  });
}

function makeManualOption(id: string, key: string) {
  return {
    id,
    namespace: 'manual',
    namespaceDisplayName: '自定义密钥',
    key,
    editable: true,
    deletable: true,
    refs: [],
    createdBy: 'alice',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };
}

function mockMutations() {
  mockUseMutation.mockImplementation((query: { definitions?: Array<{ name?: { value?: string } }> }) => {
    const operationName = query?.definitions?.[0]?.name?.value;
    if (operationName === 'CreateCustomMcpServer') return [mockCreateCustomMcpServer, { loading: false }];
    if (operationName === 'UpdateCustomMcpServer') return [mockUpdateCustomMcpServer, { loading: false }];
    if (operationName === 'DeleteCustomMcpServer') return [mockDeleteCustomMcpServer, { loading: false }];
    return [vi.fn(), { loading: false }];
  });
}

async function openCreateDialog() {
  fireEvent.click(screen.getByRole('button', { name: '新增自定义 MCP' }));
  return await screen.findByRole('dialog');
}

async function openEditDialog(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `编辑 ${name}` }));
  return await screen.findByRole('dialog');
}

function fillBasicFields(dialog: HTMLElement, name = 'my-mcp', endpoint = 'https://e.example.com/mcp') {
  fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: name } });
  fireEvent.change(within(dialog).getByLabelText('endpoint'), { target: { value: endpoint } });
}

describe('CustomMcpSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetWorkspaceStore();
    setupWorkspace(WRITABLE);
    mockQueries();
    mockMutations();
    mockCreateCustomMcpServer.mockResolvedValue({
      data: { createCustomMcpServer: makeServer() },
    });
    mockUpdateCustomMcpServer.mockResolvedValue({
      data: { updateCustomMcpServer: makeServer() },
    });
    mockDeleteCustomMcpServer.mockResolvedValue({ data: { deleteCustomMcpServer: true } });
  });

  // T-WEB2：列表与空态
  describe('T-WEB2 列表展示', () => {
    it('标题带「工作区」badge，列表展示名称/endpoint/验证方式', () => {
      mockQueries([makeServer(), MANAGED_BEARER]);
      render(<CustomMcpSection />);

      expect(screen.getByRole('heading', { name: '自定义 MCP' })).toBeInTheDocument();
      expect(screen.getByText('工作区')).toBeInTheDocument();
      expect(screen.getByText('内部文档 MCP')).toBeInTheDocument();
      expect(screen.getByText('https://mcp.example.com/sse')).toBeInTheDocument();
      expect(screen.getByText('无验证')).toBeInTheDocument();
      expect(screen.getByText('Bearer Token')).toBeInTheDocument();
    });

    it('空态展示「暂无自定义 MCP」', () => {
      mockQueries([]);
      render(<CustomMcpSection />);

      expect(screen.getByText('暂无自定义 MCP')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '编辑 内部文档 MCP' })).not.toBeInTheDocument();
    });
  });

  // T-WEB2：新增（none / bearer 两条路径）
  describe('T-WEB2 新增两路径', () => {
    it('无验证路径提交 auth={type:none} 与归一后的请求头', async () => {
      render(<CustomMcpSection />);
      const dialog = await openCreateDialog();

      fillBasicFields(dialog);
      fireEvent.click(within(dialog).getByRole('button', { name: '添加请求头' }));
      fireEvent.change(within(dialog).getByLabelText('请求头名称 1'), {
        target: { value: 'X-Api-Key' },
      });
      fireEvent.change(within(dialog).getByLabelText('请求头值 1'), {
        target: { value: 'a\nb\n' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

      await waitFor(() => {
        expect(mockCreateCustomMcpServer).toHaveBeenCalledWith({
          variables: {
            input: {
              name: 'my-mcp',
              description: null,
              endpoint: 'https://e.example.com/mcp',
              auth: { type: 'none' },
              customHeaders: [{ key: 'X-Api-Key', values: ['a', 'b'] }],
            },
          },
        });
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('自定义 MCP 已创建');
    });

    it('Bearer「填写 token」路径提交 newToken（明文仅入参）', async () => {
      render(<CustomMcpSection />);
      const dialog = await openCreateDialog();

      fillBasicFields(dialog);
      fireEvent.click(within(dialog).getByRole('radio', { name: 'Bearer Token' }));
      fireEvent.change(within(dialog).getByLabelText('Bearer token'), {
        target: { value: 'tok-123' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

      await waitFor(() => {
        expect(mockCreateCustomMcpServer).toHaveBeenCalledWith({
          variables: {
            input: expect.objectContaining({
              auth: { type: 'bearer', newToken: 'tok-123' },
            }),
          },
        });
      });
    });

    it('Bearer「选择 token」路径数据源仅 manual 并提交 existingEntryId', async () => {
      render(<CustomMcpSection />);
      const dialog = await openCreateDialog();

      fillBasicFields(dialog);
      fireEvent.click(within(dialog).getByRole('radio', { name: 'Bearer Token' }));
      fireEvent.click(
        within(within(dialog).getByRole('radiogroup', { name: 'Token 来源' })).getByRole('radio', {
          name: '选择 token',
        }),
      );
      const select = within(dialog).getByLabelText('密钥条目（仅自定义密钥）') as HTMLSelectElement;
      expect(Array.from(select.options).map((option) => option.text)).toEqual([
        '选择密钥条目',
        'manual-token-a',
        'manual-token-b',
      ]);
      fireEvent.change(select, { target: { value: 'mv-2' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

      await waitFor(() => {
        expect(mockCreateCustomMcpServer).toHaveBeenCalledWith({
          variables: {
            input: expect.objectContaining({
              auth: { type: 'bearer', existingEntryId: 'mv-2' },
            }),
          },
        });
      });
    });

    it('Bearer 未选 token 时本地拦截（bearer token is required 同源文案）', async () => {
      render(<CustomMcpSection />);
      const dialog = await openCreateDialog();

      fillBasicFields(dialog);
      fireEvent.click(within(dialog).getByRole('radio', { name: 'Bearer Token' }));
      fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('请填写 Bearer token');
      expect(mockCreateCustomMcpServer).not.toHaveBeenCalled();
    });
  });

  // T-WEB2：编辑穿透（D11）
  describe('T-WEB2 编辑穿透与就地重填', () => {
    it('bearerEntryManaged=true：就地重填 token（空待重填、不回显）', async () => {
      mockQueries([MANAGED_BEARER]);
      render(<CustomMcpSection />);
      const dialog = await openEditDialog('托管 Bearer MCP');

      const tokenInput = within(dialog).getByLabelText('Bearer token') as HTMLTextAreaElement;
      expect(tokenInput).toHaveValue('');
      expect(tokenInput).toHaveAttribute('placeholder', '输入新值（旧值不可见）');
      expect(within(dialog).queryByRole('button', { name: '前往 Valut 编辑' })).not.toBeInTheDocument();

      fireEvent.change(tokenInput, { target: { value: 'rotated' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

      await waitFor(() => {
        expect(mockUpdateCustomMcpServer).toHaveBeenCalledWith({
          variables: {
            id: 'cmcp-2',
            input: expect.objectContaining({ auth: { type: 'bearer', newToken: 'rotated' } }),
          },
        });
      });
    });

    it('未改 token 的编辑不下发 auth 字段（省略=不动）', async () => {
      mockQueries([MANAGED_BEARER]);
      render(<CustomMcpSection />);
      const dialog = await openEditDialog('托管 Bearer MCP');

      fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

      await waitFor(() => {
        expect(mockUpdateCustomMcpServer).toHaveBeenCalledTimes(1);
      });
      const input = mockUpdateCustomMcpServer.mock.calls[0][0].variables.input as Record<string, unknown>;
      expect(input).not.toHaveProperty('auth');
    });

    it('bearerEntryManaged=false：展示「前往 Valut 编辑」并导航穿透（D11）', async () => {
      mockQueries([REFERENCED_BEARER]);
      render(<CustomMcpSection />);
      const dialog = await openEditDialog('引用 Bearer MCP');

      // 默认落在「选择 token」态，选中既有引用条目
      const select = within(dialog).getByLabelText('密钥条目（仅自定义密钥）') as HTMLSelectElement;
      expect(select.value).toBe('mv-1');

      fireEvent.click(within(dialog).getByRole('button', { name: '前往 Valut 编辑' }));

      expect(mocks.navigate).toHaveBeenCalledWith('/settings?section=valut&entry=mv-1');
    });

    it('引用条目改选另一条 manual 时提交换绑 existingEntryId', async () => {
      mockQueries([REFERENCED_BEARER]);
      render(<CustomMcpSection />);
      const dialog = await openEditDialog('引用 Bearer MCP');

      fireEvent.change(within(dialog).getByLabelText('密钥条目（仅自定义密钥）'), {
        target: { value: 'mv-2' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

      await waitFor(() => {
        expect(mockUpdateCustomMcpServer).toHaveBeenCalledWith({
          variables: {
            id: 'cmcp-3',
            input: expect.objectContaining({ auth: { type: 'bearer', existingEntryId: 'mv-2' } }),
          },
        });
      });
    });
  });

  // T-WEB2：删除二次确认
  describe('T-WEB2 删除二次确认', () => {
    it('自建 token 删除提示联动删除 Valut 条目', async () => {
      mockQueries([MANAGED_BEARER]);
      render(<CustomMcpSection />);
      fireEvent.click(screen.getByRole('button', { name: '删除 托管 Bearer MCP' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('heading', { name: '删除自定义 MCP' })).toBeInTheDocument();
      expect(within(dialog).getByText(/同时删除关联的 Valut 自建 token 条目/)).toBeInTheDocument();

      fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));

      await waitFor(() => {
        expect(mockDeleteCustomMcpServer).toHaveBeenCalledWith({ variables: { id: 'cmcp-2' } });
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('自定义 MCP 已删除');
    });

    it('非自建 token 的删除不带联动提示', async () => {
      mockQueries([REFERENCED_BEARER]);
      render(<CustomMcpSection />);
      fireEvent.click(screen.getByRole('button', { name: '删除 引用 Bearer MCP' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/确定删除「引用 Bearer MCP」吗/)).toBeInTheDocument();
      expect(within(dialog).queryByText(/同时删除关联的 Valut/)).not.toBeInTheDocument();
    });
  });

  // T-WEB2：错误映射
  describe('T-WEB2 错误文案映射', () => {
    it('服务端 invalid mcp endpoint 映射为中文且对话框保持打开', async () => {
      mockCreateCustomMcpServer.mockRejectedValueOnce(new Error('invalid mcp endpoint'));
      render(<CustomMcpSection />);
      const dialog = await openCreateDialog();

      fillBasicFields(dialog);
      fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'endpoint 格式不正确（仅支持 http:// 或 https://）',
      );
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('global workspace is read-only 兜底映射为中文', async () => {
      mockCreateCustomMcpServer.mockRejectedValueOnce(new Error('global workspace is read-only'));
      render(<CustomMcpSection />);
      const dialog = await openCreateDialog();

      fillBasicFields(dialog);
      fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        '全局工作区为只读，无法操作自定义 MCP',
      );
    });

    it('endpoint 非 http(s) 时本地拦截', async () => {
      render(<CustomMcpSection />);
      const dialog = await openCreateDialog();

      fillBasicFields(dialog, 'bad', 'ftp://example.com');
      fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'endpoint 必须以 http:// 或 https:// 开头',
      );
      expect(mockCreateCustomMcpServer).not.toHaveBeenCalled();
    });
  });

  // T-WEB2：只读收敛
  describe('T-WEB2 只读收敛', () => {
    it('全局工作区 + developer 隐藏新增/编辑/删除入口但保留列表', () => {
      setupWorkspace(READONLY_GLOBAL);
      mockQueries([makeServer()]);
      render(<CustomMcpSection />);

      expect(screen.getByText('内部文档 MCP')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '新增自定义 MCP' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '编辑 内部文档 MCP' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '删除 内部文档 MCP' })).not.toBeInTheDocument();
    });
  });
});
