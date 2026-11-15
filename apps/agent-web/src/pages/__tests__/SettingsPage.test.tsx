import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import SettingsPage from '../SettingsPage';

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  setSearchParams: vi.fn(),
  navigate: vi.fn(),
}));

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [mocks.searchParams, mocks.setSearchParams],
  useNavigate: () => mocks.navigate,
}));

vi.mock('@/stores/auth', () => ({
  useAuth: () => ({ user: { name: 'tester' }, logout: vi.fn() }),
}));

// 重的既有区块打桩，聚焦设置页装配（D5 代理入口移除 + 新增两区块）
vi.mock('@/components/settings/ProviderSection', () => ({
  default: () => <div data-testid="stub-provider" />,
}));
vi.mock('@/components/settings/ModelSection', () => ({
  default: () => <div data-testid="stub-model" />,
}));
vi.mock('@/components/settings/ControllerListSection', () => ({
  default: () => <div data-testid="stub-controller" />,
}));
vi.mock('@/components/settings/GithubBindingSection', () => ({
  default: () => <div data-testid="stub-github" />,
}));
vi.mock('@/components/settings/GitSettingsSection', () => ({
  default: () => <div data-testid="stub-git" />,
}));
vi.mock('@/components/settings/WorkflowSection', () => ({
  default: () => <div data-testid="stub-workflow" />,
}));
vi.mock('@/components/settings/CloudStorageSection', () => ({
  default: () => <div data-testid="stub-storage" />,
}));
vi.mock('../ControllerConfigPage', () => ({ default: () => null }));
vi.mock('../../components/MobileBackButton', () => ({ default: () => null }));

function mockQueries() {
  mockUseQuery.mockImplementation((query: { definitions?: Array<{ name?: { value?: string } }> }) => {
    const operationName = query?.definitions?.[0]?.name?.value;
    if (operationName === 'CloudStorageCapabilities') {
      return { data: { cloudStorageCapabilities: { enabled: false } }, loading: false };
    }
    if (operationName === 'GetMcpServers') {
      return { data: { mcpServers: [] }, loading: false };
    }
    if (operationName === 'GetValutEntries') {
      return { data: { valutEntries: [] }, loading: false };
    }
    if (operationName === 'GetValutManualOptions') {
      return { data: { valutManualOptions: [] }, loading: false };
    }
    if (operationName === 'GetCustomMcpServers') {
      return { data: { customMcpServers: [] }, loading: false };
    }
    return { data: undefined, loading: false };
  });
}

describe('SettingsPage（D5 代理入口移除 / 新增 Valut 与自定义 MCP）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.searchParams = new URLSearchParams();
    mockQueries();
    mockUseMutation.mockReturnValue([vi.fn(), { loading: false }]);
  });

  it('T-WEB3：「MCP 代理」三处入口全部消失，区块标题改为「MCP 管理」', () => {
    render(<SettingsPage />);

    // 1) 区块标题；2) NAV 组 label；3) Proxy Key 区块（组件已删除）
    expect(screen.queryByText('MCP 代理')).not.toBeInTheDocument();
    expect(screen.queryByText(/MCP proxy key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/使用 MCP 代理密钥注册/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'MCP 管理' })).toBeInTheDocument();
    // MCP 目录空态为中性文案（D5）
    expect(screen.getByText('暂无已注册的 MCP 服务')).toBeInTheDocument();
  });

  it('T-WEB3：NAV 组名为「MCP」，组内含「MCP 管理」「Valut」「自定义 MCP」', () => {
    render(<SettingsPage />);

    expect(screen.getByText('MCP')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'MCP 管理' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Valut' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: '自定义 MCP' }).length).toBeGreaterThan(0);
  });

  it('T-WEB3：Valut 与自定义 MCP 区块紧随 #mcp-section 挂载', () => {
    render(<SettingsPage />);

    const mcp = document.getElementById('mcp-section');
    const valut = document.getElementById('valut-section');
    const custom = document.getElementById('custom-mcp-section');
    expect(mcp).toBeTruthy();
    expect(valut).toBeTruthy();
    expect(custom).toBeTruthy();
    expect(screen.getByTestId('valut-section')).toBeInTheDocument();
    expect(screen.getByTestId('custom-mcp-section')).toBeInTheDocument();

    // 顺序：mcp → valut → custom-mcp
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect((mcp as HTMLElement).compareDocumentPosition(valut as Node) & FOLLOWING).toBeTruthy();
    expect((valut as HTMLElement).compareDocumentPosition(custom as Node) & FOLLOWING).toBeTruthy();
    expect((mcp as HTMLElement).compareDocumentPosition(custom as Node) & FOLLOWING).toBeTruthy();
  });

  it('T-OBO-WEB1：?bind=success → 提示绑定成功并清理 URL 参数', () => {
    mocks.searchParams = new URLSearchParams('bind=success&section=valut');
    render(<SettingsPage />);

    expect(screen.getByRole('status').textContent).toContain('第三方登录绑定成功');
    expect(mocks.setSearchParams).toHaveBeenCalled();
    const next = mocks.setSearchParams.mock.calls[0][0] as URLSearchParams;
    expect(next.get('bind')).toBeNull();
    expect(next.get('section')).toBe('valut');
  });

  it('T-OBO-WEB1：?bind=error&error=... → 映射错误码并清理参数', () => {
    mocks.searchParams = new URLSearchParams('bind=error&error=invalid_bind_ticket');
    render(<SettingsPage />);

    expect(screen.getByRole('alert').textContent).toContain('绑定已过期，请重新发起');
    const next = mocks.setSearchParams.mock.calls[0][0] as URLSearchParams;
    expect(next.get('bind')).toBeNull();
    expect(next.get('error')).toBeNull();
  });

  it('T-OBO-WEB1：帐号区块挂载第三方登录绑定区块（无配置时区块自隐藏）', () => {
    render(<SettingsPage />);
    expect(document.getElementById('account-section')).toBeTruthy();
    // 无 provider/绑定数据时区块不渲染（PRD：未配置第三方登录时设置页与升级前一致）
    expect(screen.queryByTestId('external-login-binding-section')).toBeNull();
  });
});
