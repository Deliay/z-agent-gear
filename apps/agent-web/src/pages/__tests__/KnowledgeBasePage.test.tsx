import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { print } from 'graphql';
import KnowledgeBasePage from '../KnowledgeBasePage';
import type {
  KnowledgeBaseData,
  KnowledgeBaseDocumentData,
  KnowledgeBaseTreeItemData,
} from '@/graphql/knowledge-base';

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockMutate = vi.fn();
const mockNavigate = vi.fn();
const router = vi.hoisted(() => ({
  params: { kbId: 'kb-1', '*': 'guides/setup' } as Record<string, string | undefined>,
  search: new URLSearchParams(),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => router.params,
  useSearchParams: () => [router.search, vi.fn()],
  useNavigate: () => mockNavigate,
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function makeKb(overrides: Partial<KnowledgeBaseData['myAccess']> = {}): KnowledgeBaseData {
  return {
    id: 'kb-1',
    name: '开发规范',
    permissionMode: 'FULL_ACCESS',
    global: false,
    myAccess: {
      canRead: true,
      canCreate: true,
      canUpdate: true,
      canDelete: true,
      canManage: true,
      ...overrides,
    },
    createdAt: '',
    updatedAt: '',
  };
}

function makeTree(kb = makeKb()): KnowledgeBaseTreeItemData[] {
  return [
    {
      knowledgeBase: kb,
      documents: [
        { path: '/guides/setup', title: '环境搭建', tags: [], description: '', updatedAt: '' },
      ],
    },
  ];
}

const DOC: KnowledgeBaseDocumentData = {
  path: '/guides/setup',
  title: '环境搭建',
  tags: ['入门'],
  description: '上手指南',
  content: '文档正文',
  createdByName: 'alice',
  updatedByName: 'bob',
  createdAt: '',
  updatedAt: '',
};

function mockQueries(options: {
  tree?: KnowledgeBaseTreeItemData[];
  document?: KnowledgeBaseDocumentData | null;
  treeLoading?: boolean;
  documentLoading?: boolean;
}) {
  mockUseQuery.mockImplementation((document: unknown) => {
    const operation = print(document as never);
    if (operation.includes('GetKnowledgeBaseTree')) {
      return {
        data: options.treeLoading ? undefined : { knowledgeBaseTree: options.tree ?? makeTree() },
        loading: options.treeLoading ?? false,
      };
    }
    if (operation.includes('GetKnowledgeBaseDocument')) {
      return {
        data:
          options.documentLoading || options.document === undefined
            ? undefined
            : { knowledgeBaseDocument: options.document },
        loading: options.documentLoading ?? false,
      };
    }
    return { data: undefined, loading: false };
  });
}

describe('KnowledgeBasePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    router.params = { kbId: 'kb-1', '*': 'guides/setup' };
    router.search = new URLSearchParams();
    mockUseMutation.mockReturnValue([mockMutate, { loading: false }]);
    mockMutate.mockResolvedValue({ data: {} });
  });

  it('预览模式渲染文档，地址参数解析为文档路径', () => {
    mockQueries({ tree: makeTree(), document: DOC });
    render(<KnowledgeBasePage />);

    expect(screen.getByTestId('knowledge-base-title')).toHaveTextContent('环境搭建');
    expect(screen.getByTestId('knowledge-base-breadcrumb')).toHaveTextContent('guides');
  });

  it('文档不存在/不可见：统一提示且不渲染正文', () => {
    mockQueries({ tree: makeTree(), document: null });
    render(<KnowledgeBasePage />);

    expect(screen.getByText('文档不存在或你没有访问权限')).toBeInTheDocument();
    expect(screen.queryByTestId('knowledge-base-content')).not.toBeInTheDocument();
  });

  it('知识库不可见：不泄露知识库内容', () => {
    mockQueries({ tree: [], document: DOC });
    render(<KnowledgeBasePage />);

    expect(screen.getByText('知识库不存在或你没有访问权限')).toBeInTheDocument();
    expect(screen.queryByTestId('knowledge-base-preview')).not.toBeInTheDocument();
  });

  it('?edit=1 且无更新权限时不进入编辑', () => {
    router.search = new URLSearchParams('edit=1');
    mockQueries({ tree: makeTree(makeKb({ canCreate: false, canUpdate: false })), document: DOC });
    render(<KnowledgeBasePage />);

    expect(screen.getByText('没有编辑该文档的权限')).toBeInTheDocument();
    expect(screen.queryByTestId('knowledge-base-editor')).not.toBeInTheDocument();
  });

  it('?edit=1 等正文加载完成后进入编辑器', () => {
    router.search = new URLSearchParams('edit=1');
    mockQueries({ tree: makeTree(), document: DOC });
    const { rerender } = render(<KnowledgeBasePage />);
    expect(screen.getByTestId('knowledge-base-editor')).toBeInTheDocument();
    expect(screen.getByLabelText('内容')).toHaveValue('文档正文');

    // 正文未到达前不渲染编辑器（避免空表单初始化吞内容）
    mockQueries({ tree: makeTree(), document: undefined, documentLoading: true });
    rerender(<KnowledgeBasePage />);
    expect(screen.queryByTestId('knowledge-base-editor')).not.toBeInTheDocument();
    expect(screen.getByText('加载中…')).toBeInTheDocument();
  });
});
