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

interface QueryResult {
  data?: unknown;
  loading?: boolean;
  error?: unknown;
  refetch?: ReturnType<typeof vi.fn>;
}

const queryResults: Record<string, QueryResult> = {};
const queryCalls: string[] = [];

const mockUseQuery = vi.fn((query: unknown) => {
  const name =
    (query as { definitions?: Array<{ name?: { value?: string } }> })?.definitions?.[0]?.name
      ?.value ?? 'unknown';
  queryCalls.push(name);
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
  useApolloClient: () => ({ cache: { evict: mockEvict } }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
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

function setup(hosts: RepoKnowledgeBaseHostData[]) {
  queryCalls.length = 0;
  queryResults.GetRepoKnowledgeBaseHosts = { data: { repoKnowledgeBaseHosts: hosts } };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(queryResults)) delete queryResults[key];
  mockRefetchBases.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('RepoKnowledgeBaseSection（T-RKB-WEB1~6）', () => {
  it('T-RKB-WEB1 初始仅加载候选云电脑，零 bases/children 查询；全部层级默认折叠', () => {
    setup([host()]);
    render(<RepoKnowledgeBaseSection />);

    expect(screen.getByTestId('repo-knowledge-base-section')).toBeInTheDocument();
    expect(screen.getByText('云电脑一')).toBeInTheDocument();
    expect(queryCalls).toContain('GetRepoKnowledgeBaseHosts');
    expect(queryCalls).not.toContain('GetRepoKnowledgeBases');
    expect(queryCalls).not.toContain('GetRepoKnowledgeBaseChildren');

    const hostButton = screen.getByRole('button', { name: /云电脑一/ });
    expect(hostButton).toHaveAttribute('aria-expanded', 'false');
  });

  it('T-RKB-WEB2 scanSupported=false 展示升级提示且不发起 bases 查询；无候选不渲染分组', () => {
    setup([host({ scanSupported: false })]);
    const { rerender } = render(<RepoKnowledgeBaseSection />);

    expect(screen.getByTestId('repo-kb-upgrade-hint')).toHaveTextContent('升级云电脑工作组件后可加载');
    fireEvent.click(screen.getByRole('button', { name: /云电脑一/ }));
    expect(queryCalls).not.toContain('GetRepoKnowledgeBases');

    queryResults.GetRepoKnowledgeBaseHosts = { data: { repoKnowledgeBaseHosts: [] } };
    rerender(<RepoKnowledgeBaseSection />);
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
    render(<RepoKnowledgeBaseSection />);

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
    queryResults.GetRepoKnowledgeBases = {
      data: { repoKnowledgeBases: [kb()] },
      refetch: mockRefetchBases,
    };
    queryResults.GetRepoKnowledgeBaseChildren = {
      data: {
        repoKnowledgeBaseDocumentChildren: nodes([
          { kind: 'FOLDER', name: 'guides', path: '/guides' },
          { kind: 'DOCUMENT', name: '根文档', path: '/root' },
        ]),
      },
    };
    render(<RepoKnowledgeBaseSection />);

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

  it('T-RKB-WEB5 节点级失败态可重试；「重新检测」refresh:true 并失效子查询缓存', async () => {
    setup([host()]);
    queryResults.GetRepoKnowledgeBases = {
      data: { repoKnowledgeBases: [kb()] },
      refetch: mockRefetchBases,
    };
    queryResults.GetRepoKnowledgeBaseChildren = { error: new Error('boom') };
    render(<RepoKnowledgeBaseSection />);

    fireEvent.click(screen.getByRole('button', { name: /云电脑一/ }));
    fireEvent.click(screen.getByRole('button', { name: /甲库/ }));
    expect(screen.getByTestId('repo-kb-retry')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('repo-kb-refresh'));
    await waitFor(() => {
      expect(mockRefetchBases).toHaveBeenCalledWith({ workspaceId: 'ws-1', refresh: true });
      expect(mockEvict).toHaveBeenCalledWith({ fieldName: 'repoKnowledgeBaseDocumentChildren' });
      expect(mockEvict).toHaveBeenCalledWith({ fieldName: 'repoKnowledgeBaseDocument' });
    });
  });

  it('T-RKB-WEB6 全层级只读：渲染范围内无「+」与设置齿轮', () => {
    setup([host()]);
    queryResults.GetRepoKnowledgeBases = {
      data: { repoKnowledgeBases: [kb()] },
      refetch: mockRefetchBases,
    };
    render(<RepoKnowledgeBaseSection />);
    fireEvent.click(screen.getByRole('button', { name: /云电脑一/ }));

    expect(screen.queryByRole('button', { name: /新建|设置/ })).not.toBeInTheDocument();
  });
});
