import { Link } from 'react-router-dom';
import { FileClock, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import MarkdownContent from '@/components/session/MarkdownContent';
import type { KnowledgeBaseData, KnowledgeBaseDocumentData } from '@/graphql/knowledge-base';
import { breadcrumbOf, knowledgeBaseDocHref } from '@/lib/knowledge-base-path';
import { formatDateTime } from '@/lib/format';

interface KnowledgeBasePreviewProps {
  knowledgeBase: KnowledgeBaseData;
  document: KnowledgeBaseDocumentData;
  onEdit: () => void;
  onDelete: () => void;
  onHistory: () => void;
}

/**
 * 文档预览（PRD 功能点 2）：面包屑 / 标题 / 描述（灰色小字）/ 标签 / Markdown 内容。
 *
 * - 内容区 `max-w-3xl` 限宽且**靠左**（不使用 mx-auto），`min-w-0` + `wrap-anywhere`
 *   满足 frontend-rules 溢出三件套，超长无空格内容不横向溢出；
 * - 编辑/删除/历史按钮以服务端 `myAccess` 为权威（`useWorkspaceAccess` 仅收敛创建库入口）。
 */
export default function KnowledgeBasePreview({
  knowledgeBase,
  document,
  onEdit,
  onDelete,
  onHistory,
}: KnowledgeBasePreviewProps) {
  const access = knowledgeBase.myAccess;
  const crumbs = breadcrumbOf(document.path);

  return (
    <article className="min-w-0" data-testid="knowledge-base-preview">
      <div className="w-full max-w-3xl min-w-0 px-4 py-6 sm:px-6">
        <nav
          aria-label="文档路径面包屑"
          className="mb-4 flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground"
          data-testid="knowledge-base-breadcrumb"
        >
          {crumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex min-w-0 items-center gap-1">
              {index > 0 && <span className="shrink-0">/</span>}
              {index === crumbs.length - 1 ? (
                <span className="min-w-0 truncate text-foreground" aria-current="page">
                  {crumb.label}
                </span>
              ) : (
                <Link
                  to={knowledgeBaseDocHref(knowledgeBase.id, crumb.path)}
                  className="min-w-0 truncate hover:text-foreground hover:underline"
                >
                  {crumb.label}
                </Link>
              )}
            </span>
          ))}
        </nav>

        <div className="mb-2 flex min-w-0 flex-wrap items-start justify-between gap-2">
          <h1
            className="min-w-0 flex-1 wrap-anywhere text-2xl font-semibold tracking-tight"
            data-testid="knowledge-base-title"
          >
            {document.title}
          </h1>
          <div className="flex shrink-0 items-center gap-1">
            {access.canRead && (
              <Button variant="ghost" size="sm" onClick={onHistory} aria-label="历史版本">
                <FileClock className="size-3.5" />
                历史版本
              </Button>
            )}
            {access.canUpdate && (
              <Button variant="outline" size="sm" onClick={onEdit} aria-label="编辑文档">
                <Pencil className="size-3.5" />
                编辑
              </Button>
            )}
            {access.canDelete && (
              <Button variant="ghost-danger" size="sm" onClick={onDelete} aria-label="删除文档">
                <Trash2 className="size-3.5" />
                删除
              </Button>
            )}
          </div>
        </div>

        {knowledgeBase.global && (
          <Badge variant="secondary" className="mb-2" data-testid="knowledge-base-preview-global">
            全局工作区
          </Badge>
        )}

        {document.description.length > 0 && (
          <p
            className="mb-3 min-w-0 wrap-anywhere text-sm text-muted-foreground"
            data-testid="knowledge-base-description"
          >
            {document.description}
          </p>
        )}

        {document.tags.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-1" data-testid="knowledge-base-tags">
            {document.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="max-w-full truncate">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        <p className="mb-4 text-xs text-muted-foreground">
          更新人 {document.updatedByName || '未知'} · 更新于 {formatDateTime(document.updatedAt)}
        </p>

        <div className="min-w-0 wrap-anywhere text-sm leading-6" data-testid="knowledge-base-content">
          <MarkdownContent content={document.content} />
        </div>
      </div>
    </article>
  );
}
