import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import KnowledgeBaseEditor from '@/components/knowledge-base/KnowledgeBaseEditor';
import KnowledgeBaseHistoryDrawer from '@/components/knowledge-base/KnowledgeBaseHistoryDrawer';
import KnowledgeBasePreview from '@/components/knowledge-base/KnowledgeBasePreview';
import RepoKnowledgeBaseContent from '@/components/knowledge-base/RepoKnowledgeBaseContent';
import {
  DELETE_KNOWLEDGE_BASE_DOCUMENT,
  GET_KNOWLEDGE_BASE_DOCUMENT,
  GET_KNOWLEDGE_BASE_EVENTS,
  GET_KNOWLEDGE_BASE_TREE,
  GET_REPO_KNOWLEDGE_BASES,
  GET_REPO_KNOWLEDGE_BASE_DOCUMENT,
  type DeleteKnowledgeBaseDocumentMutation,
  type GetKnowledgeBaseDocumentQuery,
  type GetKnowledgeBaseTreeQuery,
  type GetRepoKnowledgeBasesQuery,
  type GetRepoKnowledgeBaseDocumentQuery,
} from '@/graphql/knowledge-base';
import { breadcrumbOf, decodeDocumentPath, knowledgeBaseDocHref } from '@/lib/knowledge-base-path';
import { decodeRepoKnowledgeBaseId, isRepoKnowledgeBaseId, sourceLabel } from '@/lib/repo-knowledge-base';
import { knowledgeBaseErrorMessage } from '@/lib/knowledge-base';

/**
 * `/knowledge-bases/:kbId/*` 路由页（D7：splat = 文档路径，`?edit=1` 编辑模式）。
 *
 * - 知识库元信息/权限来自 `knowledgeBaseTree`（与侧边栏同源）；
 * - 正文按需 `knowledgeBaseDocument`（cache-and-network），树/文档加载分支一律 `loading && !data`；
 * - 不可见/不存在统一提示且**不泄露内容**（服务端对不可见/无权限/不存在统一返回 null）。
 */
export default function KnowledgeBasePage() {
  const params = useParams();
  const kbId = params.kbId ?? '';
  const path = useMemo(() => decodeDocumentPath(params['*']), [params]);
  const [searchParams, setSearchParams] = useSearchParams();
  const edit = searchParams.get('edit') === '1';
  const navigate = useNavigate();
  const isRepo = isRepoKnowledgeBaseId(kbId);
  const decodedRepo = useMemo(() => decodeRepoKnowledgeBaseId(kbId), [kbId]);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: treeData, loading: treeLoading } = useQuery<GetKnowledgeBaseTreeQuery>(
    GET_KNOWLEDGE_BASE_TREE,
    { fetchPolicy: 'cache-and-network', skip: isRepo },
  );
  const treeItem = treeData?.knowledgeBaseTree.find(
    (item) => item.knowledgeBase.id === kbId,
  );
  const knowledgeBase = treeItem?.knowledgeBase ?? null;

  const { data: documentData, loading: documentLoading } = useQuery<GetKnowledgeBaseDocumentQuery>(
    GET_KNOWLEDGE_BASE_DOCUMENT,
    {
      variables: { knowledgeBaseId: kbId, path },
      skip: isRepo || !knowledgeBase,
      fetchPolicy: 'cache-and-network',
    },
  );
  const document = documentData?.knowledgeBaseDocument ?? null;

  const { data: repoDocumentData, loading: repoDocumentLoading } =
    useQuery<GetRepoKnowledgeBaseDocumentQuery>(GET_REPO_KNOWLEDGE_BASE_DOCUMENT, {
      variables: { id: kbId, path },
      skip: !isRepo || !decodedRepo,
      fetchPolicy: 'cache-and-network',
    });
  const { data: repoBasesData } = useQuery<GetRepoKnowledgeBasesQuery>(GET_REPO_KNOWLEDGE_BASES, {
    variables: { workspaceId: decodedRepo?.workspaceId ?? '' },
    skip: !isRepo || !decodedRepo,
    fetchPolicy: 'cache-and-network',
  });

  const [deleteDocument, { loading: deleting }] =
    useMutation<DeleteKnowledgeBaseDocumentMutation>(DELETE_KNOWLEDGE_BASE_DOCUMENT);

  const openPreview = () => {
    setSearchParams({}, { replace: true });
  };

  const handleSaved = () => {
    openPreview();
  };

  const handleDeleteDocument = async () => {
    if (!knowledgeBase || deleting) return;
    try {
      await deleteDocument({
        variables: { knowledgeBaseId: knowledgeBase.id, path },
        refetchQueries: [
          { query: GET_KNOWLEDGE_BASE_TREE },
          { query: GET_KNOWLEDGE_BASE_EVENTS, variables: { knowledgeBaseId: knowledgeBase.id } },
        ],
      });
      toast.success('文档已删除');
      setDeleteOpen(false);
      navigate(knowledgeBaseDocHref(knowledgeBase.id, '/'));
    } catch (error) {
      toast.error(knowledgeBaseErrorMessage(error, '删除文档失败，请重试'));
      setDeleteOpen(false);
    }
  };

  if (isRepo) {
    const repoDocument = repoDocumentData?.repoKnowledgeBaseDocument ?? null;
    if (!decodedRepo) {
      return (
        <div className="flex h-full items-center justify-center p-6" data-testid="knowledge-base-page">
          <div className="max-w-md space-y-2 text-center" role="alert">
            <p className="text-sm font-medium" data-testid="repo-kb-unavailable">
              知识库不存在或不可访问
            </p>
            <p className="text-xs text-muted-foreground">
              仓库知识库可能已被移动或删除，或当前工作区无权访问。
            </p>
          </div>
        </div>
      );
    }
    if (repoDocumentLoading && !repoDocumentData) {
      return (
        <output
          className="flex h-full items-center justify-center text-sm text-muted-foreground"
          aria-label="加载中"
        >
          加载中…
        </output>
      );
    }
    if (!repoDocument) {
      return (
        <div className="flex h-full items-center justify-center p-6" data-testid="knowledge-base-page">
          <div className="max-w-md space-y-2 text-center" role="alert">
            <p className="text-sm font-medium" data-testid="repo-kb-unavailable">
              知识库不存在或不可访问
            </p>
            <p className="text-xs text-muted-foreground">
              仓库知识库可能已被移动或删除，或当前工作区无权访问。
            </p>
          </div>
        </div>
      );
    }

    const repoBase =
      repoBasesData?.repoKnowledgeBases.find((item) => item.id === kbId) ?? null;
    const crumbs = breadcrumbOf(repoDocument.path).slice(1);

    return (
      <div data-testid="knowledge-base-page" data-repo="true">
        <article className="min-w-0" data-testid="repo-knowledge-base-preview">
          <div className="w-full max-w-3xl min-w-0 px-4 py-6 sm:px-6">
            <nav
              aria-label="文档路径面包屑"
              className="mb-4 flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground"
              data-testid="repo-kb-breadcrumb"
            >
              <span className="min-w-0 truncate">{repoBase?.name ?? decodedRepo.folder}</span>
              <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-xs">
                {sourceLabel(decodedRepo.source)}
              </Badge>
              {crumbs.map((crumb) => (
                <span key={crumb.path} className="flex min-w-0 items-center gap-1">
                  <span className="shrink-0">/</span>
                  <span className="min-w-0 truncate">{crumb.label}</span>
                </span>
              ))}
            </nav>
            <h1
              className="mb-4 min-w-0 wrap-anywhere text-2xl font-semibold tracking-tight"
              data-testid="knowledge-base-title"
            >
              {repoDocument.title}
            </h1>
            <p
              className="mb-4 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"
              data-testid="repo-kb-readonly-notice"
            >
              仓库内建知识库为只读来源，内容随仓库同步，不支持在线编辑。
            </p>
            <RepoKnowledgeBaseContent document={repoDocument} />
          </div>
        </article>
      </div>
    );
  }

  if (treeLoading && !treeData) {
    return (
      <output className="flex h-full items-center justify-center text-sm text-muted-foreground" aria-label="加载中">
        加载中…
      </output>
    );
  }

  if (!knowledgeBase) {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="knowledge-base-page">
        <div className="max-w-md space-y-2 text-center" role="alert">
          <p className="text-sm font-medium">知识库不存在或你没有访问权限</p>
          <p className="text-xs text-muted-foreground">
            该知识库可能已被删除，或当前工作区无权访问。
          </p>
          <Button variant="outline" onClick={() => navigate('/')}>
            返回首页
          </Button>
        </div>
      </div>
    );
  }

  const access = knowledgeBase.myAccess;

  // 编辑模式先等正文加载完成：避免 document 尚未到达时以空表单渲染编辑器
  // （随后 props 更新不会重置已初始化的表单状态，会吞掉已保存内容）。
  if (edit && documentLoading && !documentData) {
    return (
      <output className="flex h-full items-center justify-center text-sm text-muted-foreground" aria-label="加载中">
        加载中…
      </output>
    );
  }

  const isEditing = edit && (document ? access.canUpdate : access.canCreate);

  if (edit && !isEditing) {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="knowledge-base-page">
        <div className="max-w-md space-y-2 text-center" role="alert">
          <p className="text-sm font-medium">没有编辑该文档的权限</p>
          <p className="text-xs text-muted-foreground">当前知识库权限模式不允许修改文档。</p>
          <Button variant="outline" onClick={openPreview}>
            返回预览
          </Button>
        </div>
      </div>
    );
  }

  if (isEditing) {
    return (
      <div data-testid="knowledge-base-page">
        <KnowledgeBaseEditor
          key={`${knowledgeBase.id}:${path}`}
          kbId={knowledgeBase.id}
          path={path}
          document={document}
          canCreate={access.canCreate}
          canUpdate={access.canUpdate}
          onCancel={openPreview}
          onSaved={handleSaved}
        />
      </div>
    );
  }

  if (documentLoading && !documentData) {
    return (
      <output className="flex h-full items-center justify-center text-sm text-muted-foreground" aria-label="加载中">
        加载中…
      </output>
    );
  }

  if (!document) {
    if (path === '/') {
      return (
        <div className="min-w-0 p-6" data-testid="knowledge-base-page">
          <div className="max-w-3xl">
            <h1 className="min-w-0 wrap-anywhere text-2xl font-semibold">{knowledgeBase.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              从左侧知识库树选择文档查看，或使用条目「+」创建新文档。
            </p>
            {access.canCreate && (
              <Button
                className="mt-4"
                variant="outline"
                onClick={() => navigate(knowledgeBaseDocHref(knowledgeBase.id, path, true))}
              >
                在此路径新建文档
              </Button>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="knowledge-base-page">
        <div className="max-w-md space-y-2 text-center" role="alert">
          <p className="text-sm font-medium">文档不存在或你没有访问权限</p>
          <p className="truncate font-mono text-xs text-muted-foreground" title={path}>
            {path}
          </p>
          <Button variant="outline" onClick={() => navigate(knowledgeBaseDocHref(knowledgeBase.id, '/'))}>
            返回知识库
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="knowledge-base-page">
      <KnowledgeBasePreview
        knowledgeBase={knowledgeBase}
        document={document}
        onEdit={() => navigate(knowledgeBaseDocHref(knowledgeBase.id, path, true))}
        onDelete={() => setDeleteOpen(true)}
        onHistory={() => setHistoryOpen(true)}
      />

      <KnowledgeBaseHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        knowledgeBaseId={knowledgeBase.id}
        path={path}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`删除文档「${document.title}」？`}
        description="删除后该路径将被释放，可立即以相同路径重新创建；历史记录仍会保留。"
        confirmLabel="删除"
        loading={deleting}
        onConfirm={handleDeleteDocument}
      />
    </div>
  );
}
