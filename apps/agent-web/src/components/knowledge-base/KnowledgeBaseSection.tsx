import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { FileText, Folder, Plus, Settings } from 'lucide-react';
import SidebarSection from '@/components/sidebar/SidebarSection';
import TreeSection from '@/components/tree/TreeSection';
import { Badge } from '@/components/ui/badge';
import {
  CREATE_KNOWLEDGE_BASE_DOCUMENT,
  GET_KNOWLEDGE_BASE_TREE,
  GET_REPO_KNOWLEDGE_BASE_HOSTS,
  type CreateKnowledgeBaseDocumentMutation,
  type GetKnowledgeBaseTreeQuery,
  type GetRepoKnowledgeBaseHostsQuery,
  type KnowledgeBaseData,
  type KnowledgeBaseDocumentMetaData,
} from '@/graphql/knowledge-base';
import {
  buildKnowledgeBaseTree,
  joinDocPath,
  knowledgeBaseDocHref,
  newDocumentName,
  type KnowledgeBaseTreeNode,
} from '@/lib/knowledge-base-path';
import { knowledgeBaseErrorMessage } from '@/lib/knowledge-base';
import { useWorkspaceAccess } from '@/stores/workspace';
import CreateKnowledgeBaseDialog from './CreateKnowledgeBaseDialog';
import KnowledgeBaseSettingsDialog from './KnowledgeBaseSettingsDialog';
import RepoKnowledgeBaseSection from './RepoKnowledgeBaseSection';

/**
 * 侧边栏「知识库」分区（第五分区，位置「会话」之后、「网关」之前，D8）。
 *
 * - 树结构：知识库 → 路径层级（虚拟目录 + 文档节点），展示文档标题；
 * - 分区「+」创建知识库（**仅租户管理员**，F17）；条目「+」按 `myAccess.canCreate`
 *   **点击即持久化**子文档（D9：标题 `新文档-{后缀}`、空内容）并跳 `?edit=1`；
 * - 设置齿轮打开知识库设置（重命名/权限四档/全库历史/删除）；
 * - 树查询独立于 HOME_OVERVIEW（D4），`cache-and-network` + mutation refetch。
 */
interface KnowledgeBaseSectionProps {
  expanded?: boolean;
  onToggle?: () => void;
  /** 领域专视图嵌入模式：不包裹外层可折叠 SidebarSection */
  embedded?: boolean;
}

interface DocumentNodeProps {
  node: KnowledgeBaseTreeNode<KnowledgeBaseDocumentMetaData>;
  kbId: string;
  canCreate: boolean;
  creatingKey: string | null;
  onCreateChild: (parentPath: string) => void;
  onOpen: (path: string) => void;
}

function DocumentNode({
  node,
  kbId,
  canCreate,
  creatingKey,
  onCreateChild,
  onOpen,
}: DocumentNodeProps) {
  const label = node.document?.title ?? node.name;
  return (
    <li data-testid="knowledge-base-doc-node" data-path={node.path}>
      <div className="flex min-w-0 items-center gap-1 rounded px-2 py-1 transition-colors hover:bg-sidebar-accent/60">
        {node.document ? (
          <>
            <FileText className="size-3 shrink-0 text-muted-foreground" />
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-sm text-sidebar-foreground"
              title={node.path}
              onClick={() => onOpen(node.path)}
              data-testid="knowledge-base-doc-link"
            >
              {label}
            </button>
            {canCreate && (
              <button
                type="button"
                className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={`在 ${label} 下新建文档`}
                title="新建子文档"
                disabled={creatingKey === `${kbId}:${node.path}`}
                onClick={() => onCreateChild(node.path)}
              >
                <Plus className="size-3" />
              </button>
            )}
          </>
        ) : (
          <>
            <Folder className="size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={node.path}>
              {node.name}
            </span>
            {canCreate && (
              <button
                type="button"
                className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={`在 ${node.name} 下新建文档`}
                title="新建子文档"
                disabled={creatingKey === `${kbId}:${node.path}`}
                onClick={() => onCreateChild(node.path)}
              >
                <Plus className="size-3" />
              </button>
            )}
          </>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="ml-3 space-y-0.5 border-l border-sidebar-border/60 pl-1">
          {node.children.map((child) => (
            <DocumentNode
              key={child.path}
              node={child}
              kbId={kbId}
              canCreate={canCreate}
              creatingKey={creatingKey}
              onCreateChild={onCreateChild}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function KnowledgeBaseSection({
  expanded = true,
  onToggle = () => {},
  embedded = false,
}: KnowledgeBaseSectionProps) {
  const navigate = useNavigate();
  const { isAdmin } = useWorkspaceAccess();
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsKb, setSettingsKb] = useState<KnowledgeBaseData | null>(null);
  const [creatingKey, setCreatingKey] = useState<string | null>(null);

  const { data, loading, refetch } = useQuery<GetKnowledgeBaseTreeQuery>(GET_KNOWLEDGE_BASE_TREE, {
    fetchPolicy: 'cache-and-network',
  });
  // hosts 查询上提到分区层：用于「暂无知识库」双空判定与「重新检测」入口（D9/D10）
  const {
    data: hostsData,
    loading: hostsLoading,
    error: hostsError,
    refetch: refetchHosts,
  } = useQuery<GetRepoKnowledgeBaseHostsQuery>(GET_REPO_KNOWLEDGE_BASE_HOSTS, {
    fetchPolicy: 'cache-and-network',
  });
  const [createDocument] = useMutation<CreateKnowledgeBaseDocumentMutation>(
    CREATE_KNOWLEDGE_BASE_DOCUMENT,
  );

  const items = useMemo(
    () =>
      [...(data?.knowledgeBaseTree ?? [])].sort((a, b) => {
        const diff = a.knowledgeBase.name.localeCompare(b.knowledgeBase.name);
        return diff !== 0 ? diff : a.knowledgeBase.id.localeCompare(b.knowledgeBase.id);
      }),
    [data?.knowledgeBaseTree],
  );
  const hosts = hostsData?.repoKnowledgeBaseHosts ?? [];
  const hostsPending = hostsLoading && !hostsData;
  // 空态口径（D9）：「暂无知识库」仅在平台库与仓库知识库都为空、hosts 已定态且查询成功时展示
  const showEmptyState = items.length === 0 && !hostsError && !hostsPending && hosts.length === 0;
  const showPlatformLoading = (loading && !data) || (items.length === 0 && hostsPending);

  const handleCreateChild = async (kb: KnowledgeBaseData, parentPath: string) => {
    const name = newDocumentName();
    const path = joinDocPath(parentPath, name);
    setCreatingKey(`${kb.id}:${parentPath}`);
    try {
      await createDocument({
        variables: {
          knowledgeBaseId: kb.id,
          path,
          input: { title: name, tags: [], description: '', content: '' },
        },
        refetchQueries: [{ query: GET_KNOWLEDGE_BASE_TREE }],
      });
      navigate(knowledgeBaseDocHref(kb.id, path, true));
    } catch (error) {
      toast.error(knowledgeBaseErrorMessage(error, '创建文档失败，请重试'));
    } finally {
      setCreatingKey(null);
    }
  };

  const body = (
    <>
      {embedded && isAdmin && (
        <div className="mb-2 flex justify-end px-1">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-sidebar-border bg-card px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="新建知识库"
            aria-label="新建知识库"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-3.5" />
            <span>新建知识库</span>
          </button>
        </div>
      )}
      {showPlatformLoading ? (
        <div className="px-2 py-1 text-xs text-muted-foreground/60">加载中…</div>
      ) : showEmptyState ? (
        <div className="px-2 py-1 text-xs text-muted-foreground/60">暂无知识库</div>
      ) : items.length === 0 ? null : (
        <div className="space-y-0.5">
          {items.map(({ knowledgeBase, documents }) => {
            const tree = buildKnowledgeBaseTree(documents);
            const canCreate = knowledgeBase.myAccess.canCreate;
            return (
              <div key={knowledgeBase.id} data-testid={`knowledge-base-item-${knowledgeBase.id}`}>
                <TreeSection
                  title={knowledgeBase.name}
                  count={documents.length}
                  defaultExpanded
                  hasContent={documents.length > 0}
                  actions={
                    <div className="flex items-center gap-0.5">
                      {knowledgeBase.global && (
                        <Badge
                          variant="secondary"
                          className="shrink-0 px-1.5 py-0 text-xs"
                          data-testid="knowledge-base-global-badge"
                        >
                          全局
                        </Badge>
                      )}
                      {canCreate && (
                        <button
                          type="button"
                          className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`在 ${knowledgeBase.name} 中新建文档`}
                          title="新建文档"
                          disabled={creatingKey === `${knowledgeBase.id}:/`}
                          onClick={() => void handleCreateChild(knowledgeBase, '/')}
                        >
                          <Plus className="size-3" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                        aria-label={`${knowledgeBase.name} 设置`}
                        title="知识库设置"
                        onClick={() => setSettingsKb(knowledgeBase)}
                      >
                        <Settings className="size-3" />
                      </button>
                    </div>
                  }
                >
                  {tree.map((node) => (
                    <DocumentNode
                      key={node.path}
                      node={node}
                      kbId={knowledgeBase.id}
                      canCreate={canCreate}
                      creatingKey={creatingKey}
                      onCreateChild={(parentPath) => void handleCreateChild(knowledgeBase, parentPath)}
                      onOpen={(path) => navigate(knowledgeBaseDocHref(knowledgeBase.id, path))}
                    />
                  ))}
                </TreeSection>
              </div>
            );
          })}
        </div>
      )}

      {!(items.length === 0 && hostsPending) && (
        <RepoKnowledgeBaseSection
          hosts={hosts}
          loading={hostsLoading}
          error={hostsError}
          onRetry={() => void refetchHosts()}
        />
      )}
    </>
  );

  return (
    <>
      {embedded ? (
        <div data-testid="sidebar-section-content-knowledgeBases">{body}</div>
      ) : (
        <SidebarSection
          sectionKey="knowledgeBases"
          title="知识库"
          count={items.length}
          expanded={expanded}
          onToggle={onToggle}
          actions={
            isAdmin ? (
              <button
                type="button"
                className="cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                title="新建知识库"
                aria-label="新建知识库"
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="size-3.5" />
              </button>
            ) : undefined
          }
        >
          {body}
        </SidebarSection>
      )}

      <CreateKnowledgeBaseDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void refetch();
        }}
      />

      {settingsKb && (
        <KnowledgeBaseSettingsDialog
          open
          knowledgeBase={settingsKb}
          onClose={() => setSettingsKb(null)}
          onChanged={() => void refetch()}
          onDeleted={() => {
            setSettingsKb(null);
            navigate('/');
          }}
        />
      )}
    </>
  );
}
