import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import RepoKnowledgeBaseSection from '../RepoKnowledgeBaseSection';
import type {
  RepoKnowledgeBaseData,
  RepoKnowledgeBaseHostData,
  RepoKnowledgeBaseNodeData,
} from '@/graphql/knowledge-base';

const mockNavigate = vi.fn();
const mockEvict = vi.fn();
const mockRefetchBases = vi.fn();
const mockClientQuery = vi.fn();
const mockToastError = vi.fn();

interface QueryResult {
  data?: unknown;
  loading?: boolean;
  error?: unknown;
  refetch?: ReturnType<typeof vi.fn>;
}

const queryResults: Record<string, QueryResult> = {};
const queryCalls: string[] = [];
const queryOptions: Record<string, unknown> = {};

const mockUseQuery = vi.fn((query: unknown, options?: unknown) => {
  const name =
    (query as { definitions?: Array<{ name?: { value?: string } }> })?.definitions?.[0]?.name
      ?.value ?? 'unknown';
  queryCalls.push(name);
  queryOptions[name] = options;
  const result = queryResults[name] ?? {};
  return {
    data: result.data,
    loading: result.loading ?? false,
    error: result.error,
    refetch: result.refetch ?? vi.fn(),
  };
});

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...(args as [unknown])),
  useApolloClient: () => ({ cache: { evict: mockEvict }, query: mockClientQuery }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => mockToastError(...args) },
}));

function host(overrides: Partial<RepoKnowledgeBaseHostData> = {}): RepoKnowledgeBaseHostData {
  return {
    cloudHostId: 'h1',
    cloudHostName: '云电脑一',
    workspaceId: 'ws-1',
    scanSupported: true,
    ...overrides,
  };
}

function kb(overrides: Partial<RepoKnowledgeBaseData> = {}): RepoKnowledgeBaseData {
  return {
    id: 'repo:ws-1:zag:a-base',
    name: '甲库',
    description: '',
    source: 'ZAG',
    folder: 'a-base',
    workspaceId: 'ws-1',
    cloudHostId: 'h1',
    cloudHostName: '云电脑一',
    valid: true,
    errors: [],
    documentCount: 2,
    truncated: false,
    ...overrides,
  };
}

function nodes(list: RepoKnowledgeBaseNodeData[]): RepoKnowledgeBaseNodeData[] {
  return list;
}

function setup(_hosts: RepoKnowledgeBaseHostData[]) {
  queryCalls.length = 0;
  queryResults.GetRepoKnowledgeBases = {
    data: { repoKnowledgeBases: [kb()] },
    refetch: mockRefetchBases,
  };
}

function renderSection(hosts: RepoKnowledgeBaseHostData[] = [host()]) {
  return render(
    <RepoKnowledgeBaseSection hosts={hosts} loading={false} error={undefined} onRetry={vi.fn()} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(queryResults)) delete queryResults[key];
  mockRefetchBases.mockResolvedValue({});
  mockClientQuery.mockResolvedValue({ data: { repoKnowledgeBases: [kb()] } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('RepoKnowledgeBaseSection（T-RKB-WEB1~6 / T-RKB2-WEB4~5）', () => {
  it('T-RKB-WEB1 hosts 由 props 下发：初始零 bases/children 查询；全部层级默认折叠', () => {
    setup([host()]);
    renderSection();

    expect(screen.getByTestId('repo-knowledge-base-section')).toBeInTheDocument();
    expect(screen.getByText('云电脑一')).toBeInTheDocument();
    expect(queryCalls).not.toContain('GetRepoKnowledgeBaseHosts');
    // skip:true 时不发起 bases 请求（hook 调用存在但无网络请求）
    expect(queryOptions.GetRepoKnowledgeBases).toEqual(
      expect.objectContaining({ skip: true }),
    );
    expect(queryCalls).not.toContain('GetRepoKnowledgeBaseChildren');

    const hostButton = screen.getByRole('button', { name: /云电脑一/ });
    expect(hostButton).toHaveAttribute('aria-expanded', 'false');
  });

  it('T-RKB-WEB2 scanSupported=false 展示升级提示且不发起 bases 查询；无候选不渲染分组', () => {
    setup([host({ scanSupported: false })]);
    const { rerender } = renderSection([host({ scanSupported: false })]);

    expect(screen.getByTestId('repo-kb-upgrade-hint')).toHaveTextContent('升级云电脑工作组件后可加载');
    fireEvent.click(screen.getByRole('button', { name: /云电脑一/ }));
    expect(queryOptions.GetRepoKnowledgeBases).toEqual(expect.objectContaining({ skip: true }));
    expect(screen.queryByTestId('repo-kb-refresh')).not.toBeInTheDocument();

    rerender(<RepoKnowledgeBaseSection hosts={[]} loading={false} onRetry={vi.fn()} />);
    expect(screen.queryByTestId('repo-knowledge-base-section')).not.toBeInTheDocument();
  });

  it('T-RKB-WEB3 展开云电脑才发 bases 查询；来源 Badge/文档数；不合法库灰显 errors[0]；空态', () => {
    setup([host()]);
    queryResults.GetRepoKnowledgeBases = {
      data: {
        repoKnowledgeBases: [
          kb(),
          kb({
            id: 'repo:ws-1:docs:b-bad',
            name: '',
            folder: 'b-bad',
            source: 'DOCS',
            valid: false,
            errors: ['knowledge-base.json 不是合法的 JSON 文件'],
            documentCount: 0,
          }),
        ],
      },
      refetch: mockRefetchBases,
    };
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: /云电脑一/ }));

    expect(queryCalls).toContain('GetRepoKnowledgeBases');
    expect(screen.getByText('甲库')).toBeInTheDocument();
    expect(screen.getAllByTestId('repo-kb-source-badge').map((item) => item.textContent)).toEqual([
      'zag',
      'docs',
    ]);
    expect(screen.getByTestId('repo-kb-error')).toHaveTextContent('不是合法的 JSON 文件');
    expect(screen.getByRole('button', { name: /b-bad/ })).toBeDisabled();

    queryResults.GetRepoKnowledgeBases = { data: { repoKnowledgeBases: [] } };
    fireEvent.click(screen.getByRole('button', { name: /云电脑一/ }));
    fireEvent.click(screen.getByRole('button', { name: /云电脑一/ }));
    expect(screen.getByText('未检测到仓库知识库')).toBeInTheDocument();
  });

  it('T-RKB-WEB4 展开知识库/目录才发 children 查询；FOLDER 在前；点击文档导航', () => {
    setup([host()]);
    queryResults.GetRepoKnowledgeBaseChildren = {
      data: {
        repoKnowledgeBaseDocumentChildren: nodes([
          { kind: 'FOLDER', name: 'guides', path: '/guides' },
          { kind: 'DOCUMENT', name: '根文档', path: '/root' },
        ]),
      },
    };
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: /云电脑一/ }));
    expect(queryCalls).not.toContain('GetRepoKnowledgeBaseChildren');
    fireEvent.click(screen.getByRole('button', { name: /甲库/ }));

    expect(queryCalls).toContain('GetRepoKnowledgeBaseChildren');
    const folder = screen.getByTestId('repo-kb-folder-node');
    const doc = screen.getByTestId('repo-kb-document-node');
    expect(folder.compareDocumentPosition(doc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByTestId('repo-kb-document-link'));
    expect(mockNavigate).toHaveBeenCalledWith('/knowledge-bases/repo:ws-1:zag:a-base/root');
  });

  it('T-RKB-WEB5 节点级失败态可重试', () => {
    setup([host()]);
    queryResults.GetRepoKnowledgeBaseChildren = { error: new Error('boom') };
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: /云电脑一/ }));
    fireEvent.click(screen.getByRole('button', { name: /甲库/ }));
    expect(screen.getByTestId('repo-kb-retry')).toBeInTheDocument();
  });

  it('T-RKB-WEB6 全层级只读：渲染范围内无「+」与设置齿轮', () => {
    setup([host()]);
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /云电脑一/ }));

    expect(screen.queryByRole('button', { name: /新建|设置/ })).not.toBeInTheDocument();
  });

  it('T-RKB2-WEB4 行尾仅图标刷新：折叠态走 client.query(refresh:true) 并失效子查询', async () => {
    setup([host()]);
    renderSection();

    const refresh = screen.getByTestId('repo-kb-refresh');
    expect(refresh).toHaveAttribute('aria-label', '重新检测');
    expect(refresh).toHaveAttribute('title', '重新检测');
    expect(refresh).toHaveTextContent('');

    fireEvent.click(refresh);
    await waitFor(() => {
      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: { workspaceId: 'ws-1', refresh: true },
          fetchPolicy: 'network-only',
        }),
      );
      expect(mockEvict).toHaveBeenCalledWith({ fieldName: 'repoKnowledgeBaseDocumentChildren' });
      expect(mockEvict).toHaveBeenCalledWith({ fieldName: 'repoKnowledgeBaseDocument' });
    });
    // 折叠态刷新不触发（未挂载的）bases refetch
    expect(mockRefetchBases).not.toHaveBeenCalled();
  });

  it('T-RKB2-WEB4b 展开态刷新走 refetch(refresh:true)；刷新中禁用；失败 toast', async () => {
    setup([host()]);
    let resolveRefetch: (value: unknown) => void = () => {};
    mockRefetchBases.mockReturnValue(
      new Promise((resolve) => {
        resolveRefetch = resolve;
      }),
    );
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: /云电脑一/ }));
    const refresh = screen.getByTestId('repo-kb-refresh');
    fireEvent.click(refresh);

    await waitFor(() => {
      expect(mockRefetchBases).toHaveBeenCalledWith({ workspaceId: 'ws-1', refresh: true });
    });
    expect(refresh).toBeDisabled();
    expect(refresh.querySelector('.animate-spin')).toBeTruthy();

    resolveRefetch({});
    await waitFor(() => expect(refresh).not.toBeDisabled());

    mockRefetchBases.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(refresh);
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('重新检测失败，请重试'));
  });

  it('T-RKB2-WEB5 truncated 库展示「已截断」；error 文档灰显「文件过大」且无链接', () => {
    setup([host()]);
    queryResults.GetRepoKnowledgeBases = {
      data: { repoKnowledgeBases: [kb({ truncated: true })] },
      refetch: mockRefetchBases,
    };
    queryResults.GetRepoKnowledgeBaseChildren = {
      data: {
        repoKnowledgeBaseDocumentChildren: nodes([
          { kind: 'DOCUMENT', name: '正常文档', path: '/ok' },
          { kind: 'DOCUMENT', name: 'big', path: '/big', error: 'file too large' },
        ]),
      },
    };
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: /云电脑一/ }));
    expect(screen.getByTestId('repo-kb-truncated-badge')).toHaveTextContent('已截断');

    fireEvent.click(screen.getByRole('button', { name: /甲库/ }));
    expect(screen.getByTestId('repo-kb-document-error')).toHaveTextContent('文件过大');
    expect(screen.queryByRole('button', { name: /big/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /正常文档/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/knowledge-bases/repo:ws-1:zag:a-base/ok');
  });
});
