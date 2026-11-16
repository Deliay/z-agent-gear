import { useState } from 'react';
import { useApolloClient, useQuery } from '@apollo/client/react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, BookOpen, ChevronDown, ChevronRight, FileText, Folder, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  GET_REPO_KNOWLEDGE_BASE_CHILDREN,
  GET_REPO_KNOWLEDGE_BASE_HOSTS,
  GET_REPO_KNOWLEDGE_BASES,
  type GetRepoKnowledgeBaseChildrenQuery,
  type GetRepoKnowledgeBaseHostsQuery,
  type GetRepoKnowledgeBasesQuery,
  type RepoKnowledgeBaseData,
  type RepoKnowledgeBaseHostData,
  type RepoKnowledgeBaseNodeData,
} from '@/graphql/knowledge-base';
import { knowledgeBaseDocHref } from '@/lib/knowledge-base-path';
import { sourceLabel } from '@/lib/repo-knowledge-base';

/**
 * 侧边栏「知识库」分区内的「仓库知识库」子分组（需求 #545）。
 *
 * - 数据源 `GET_REPO_KNOWLEDGE_BASE_HOSTS`（纯 DB 骨架，`cache-and-network`）：
 *   初始加载**不触发任何仓库扫描**；
 * - **全部层级默认折叠**：展开云电脑才发 `GET_REPO_KNOWLEDGE_BASES`；
 *   展开知识库/目录才发 `GET_REPO_KNOWLEDGE_BASE_CHILDREN`（逐级懒加载）；
 * - 各节点独立加载/失败态与「重试」，失败不扩散兄弟节点；
 * - 条目只读（无「+」/设置齿轮）；`scanSupported=false` 展示升级提示且不发起加载。
 */

function Loading() {
  return <div className="px-2 py-1 text-xs text-muted-foreground/60">加载中…</div>;
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center gap-1 px-2 py-1 text-xs text-destructive">
      <span className="min-w-0 flex-1">加载失败</span>
      <button
        type="button"
        className="shrink-0 cursor-pointer underline"
        onClick={onRetry}
        data-testid="repo-kb-retry"
      >
        重试
      </button>
    </div>
  );
}

function FolderNode({
  node,
  id,
  level,
}: {
  node: RepoKnowledgeBaseNodeData;
  id: string;
  level: number;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);

  if (node.kind === 'DOCUMENT') {
    return (
      <li data-testid="repo-kb-document-node" data-path={node.path}>
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-1 rounded px-2 py-1 text-left text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60"
          title={node.path}
          onClick={() => navigate(knowledgeBaseDocHref(id, node.path))}
          data-testid="repo-kb-document-link"
        >
          <FileText className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
        </button>
      </li>
    );
  }

  return (
    <li data-testid="repo-kb-folder-node" data-path={node.path}>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1 rounded px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/60"
        title={node.path}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        <Folder className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </button>
      {expanded && <RepoChildren id={id} path={node.path} level={level + 1} />}
    </li>
  );
}

function RepoChildren({
  id,
  path,
  level,
}: {
  id: string;
  path: string;
  level: number;
}) {
  const { data, loading, error, refetch } = useQuery<GetRepoKnowledgeBaseChildrenQuery>(
    GET_REPO_KNOWLEDGE_BASE_CHILDREN,
    { variables: { id, path }, fetchPolicy: 'cache-and-network' },
  );

  if (loading && !data) return <Loading />;
  if (error) return <LoadError onRetry={() => void refetch()} />;

  const nodes = data?.repoKnowledgeBaseDocumentChildren ?? [];
  if (nodes.length === 0) {
    return <div className="px-2 py-1 text-xs text-muted-foreground/60">空目录</div>;
  }

  return (
    <ul className="ml-3 space-y-0.5 border-l border-sidebar-border/60 pl-1" data-level={level}>
      {nodes.map((node) => (
        <FolderNode key={node.path} node={node} id={id} level={level} />
      ))}
    </ul>
  );
}

function KnowledgeBaseItem({ knowledgeBase }: { knowledgeBase: RepoKnowledgeBaseData }) {
  const [expanded, setExpanded] = useState(false);
  const sourceBadge = knowledgeBase.source === 'ZAG' ? 'zag' : 'docs';

  return (
    <li data-testid={`repo-kb-item-${knowledgeBase.id}`}>
      <button
        type="button"
        className={`flex w-full min-w-0 items-center gap-1 rounded px-2 py-1 text-left transition-colors hover:bg-sidebar-accent/60 ${
          knowledgeBase.valid ? '' : 'opacity-60'
        }`}
        aria-expanded={expanded}
        disabled={!knowledgeBase.valid}
        onClick={() => setExpanded((value) => !value)}
      >
        {knowledgeBase.valid ? (
          expanded ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )
        ) : (
          <AlertCircle className="size-3 shrink-0 text-destructive" />
        )}
        <BookOpen className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground">
          {knowledgeBase.valid ? knowledgeBase.name : knowledgeBase.folder}
        </span>
        <Badge
          variant="outline"
          className="shrink-0 px-1 py-0 text-[9px]"
          title={sourceLabel(knowledgeBase.source)}
          data-testid="repo-kb-source-badge"
        >
          {sourceBadge}
        </Badge>
        {knowledgeBase.valid && (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {knowledgeBase.documentCount}
          </span>
        )}
      </button>
      {!knowledgeBase.valid && knowledgeBase.errors[0] && (
        <p className="px-6 pb-1 text-[10px] text-destructive" data-testid="repo-kb-error">
          {knowledgeBase.errors[0]}
        </p>
      )}
      {knowledgeBase.valid && expanded && (
        <RepoChildren id={knowledgeBase.id} path="/" level={1} />
      )}
    </li>
  );
}

function RepoKnowledgeBaseList({ host }: { host: RepoKnowledgeBaseHostData }) {
  const client = useApolloClient();
  const { data, loading, error, refetch } = useQuery<GetRepoKnowledgeBasesQuery>(
    GET_REPO_KNOWLEDGE_BASES,
    {
      variables: { workspaceId: host.workspaceId },
      fetchPolicy: 'cache-and-network',
    },
  );

  if (loading && !data) return <Loading />;
  if (error) return <LoadError onRetry={() => void refetch()} />;

  const bases = data?.repoKnowledgeBases ?? [];

  const handleRefresh = async () => {
    await refetch({ workspaceId: host.workspaceId, refresh: true });
    // 缓存失效：已展开的子条目/文档按新扫描结果重拉。
    // Apollo `evict` 仅按 fieldName 失效（无法按 workspace 维度区分 variables），
    // 因此为全局失效——多余请求可接受，对齐计划 D10「按 field 关键词失效」口径。
    client.cache.evict({ fieldName: 'repoKnowledgeBaseDocumentChildren' });
    client.cache.evict({ fieldName: 'repoKnowledgeBaseDocument' });
  };

  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-end px-2">
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => void handleRefresh()}
          data-testid="repo-kb-refresh"
        >
          <RefreshCw className="size-3" />
          重新检测
        </button>
      </div>
      {bases.length === 0 ? (
        <div className="px-2 py-1 text-xs text-muted-foreground/60">未检测到仓库知识库</div>
      ) : (
        <ul className="space-y-0.5">
          {bases.map((knowledgeBase) => (
            <KnowledgeBaseItem key={knowledgeBase.id} knowledgeBase={knowledgeBase} />
          ))}
        </ul>
      )}
    </div>
  );
}

function HostNode({ host }: { host: RepoKnowledgeBaseHostData }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li data-testid={`repo-kb-host-${host.cloudHostId}`}>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1 rounded px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/60"
        aria-expanded={expanded}
        disabled={!host.scanSupported}
        onClick={() => setExpanded((value) => !value)}
      >
        {host.scanSupported ? (
          expanded ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )
        ) : (
          <AlertCircle className="size-3 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{host.cloudHostName}</span>
      </button>
      {!host.scanSupported && (
        <div
          className="px-6 pb-1 text-[10px] text-muted-foreground/60"
          data-testid="repo-kb-upgrade-hint"
        >
          升级云电脑工作组件后可加载
        </div>
      )}
      {host.scanSupported && expanded && <RepoKnowledgeBaseList host={host} />}
    </li>
  );
}

export default function RepoKnowledgeBaseSection() {
  const { data, loading, error, refetch } = useQuery<GetRepoKnowledgeBaseHostsQuery>(
    GET_REPO_KNOWLEDGE_BASE_HOSTS,
    { fetchPolicy: 'cache-and-network' },
  );

  const hosts = data?.repoKnowledgeBaseHosts ?? [];
  if (loading && !data) return <Loading />;
  if (error) return <LoadError onRetry={() => void refetch()} />;
  // 无候选云电脑：整个子分组不渲染（D12）
  if (hosts.length === 0) return null;

  return (
    <div className="mt-1 border-t border-sidebar-border/60 pt-1" data-testid="repo-knowledge-base-section">
      <div className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground">
        <BookOpen className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">仓库知识库</span>
        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px]">{hosts.length}</span>
      </div>
      <ul className="space-y-0.5">
        {hosts.map((host) => (
          <HostNode key={host.cloudHostId} host={host} />
        ))}
      </ul>
    </div>
  );
}
