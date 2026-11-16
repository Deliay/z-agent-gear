import { useState } from 'react';
import { useQuery } from '@apollo/client/react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import MarkdownContent from '@/components/session/MarkdownContent';
import {
  GET_KNOWLEDGE_BASE_EVENTS,
  type GetKnowledgeBaseEventsQuery,
} from '@/graphql/knowledge-base';
import { EVENT_OP_LABELS } from '@/lib/knowledge-base';
import { formatDateTime } from '@/lib/format';

interface KnowledgeBaseHistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  knowledgeBaseId: string;
  path: string;
}

/**
 * 文档历史版本抽屉（PRD 功能点 4）：版本下拉（createdAt 倒序，服务端保证）+ 所选版本只读预览。
 * 已删除路径的历史同样可见（事件集合与文档存续无关）。
 */
export default function KnowledgeBaseHistoryDrawer({
  open,
  onClose,
  knowledgeBaseId,
  path,
}: KnowledgeBaseHistoryDrawerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, loading } = useQuery<GetKnowledgeBaseEventsQuery>(GET_KNOWLEDGE_BASE_EVENTS, {
    variables: { knowledgeBaseId, path, limit: 50 },
    skip: !open,
    fetchPolicy: 'cache-and-network',
  });

  const events = data?.knowledgeBaseEvents ?? [];
  const selected = events.find((event) => event.id === selectedId) ?? events[0] ?? null;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent className="sm:max-w-xl" data-testid="knowledge-base-history-drawer">
        <SheetHeader>
          <SheetTitle>历史版本</SheetTitle>
          <SheetDescription className="truncate font-mono text-xs" title={path}>
            {path}
          </SheetDescription>
        </SheetHeader>

        {loading && !data ? (
          <p className="text-xs text-muted-foreground">加载中…</p>
        ) : events.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="knowledge-base-history-empty">
            暂无历史版本
          </p>
        ) : (
          <>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>选择版本</span>
              <select
                aria-label="历史版本选择"
                data-testid="knowledge-base-history-select"
                className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2 py-1.5 text-sm"
                value={selected?.id ?? ''}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {events.map((event) => (
                  <option key={event.id} value={event.id}>
                    {EVENT_OP_LABELS[event.op]} · {formatDateTime(event.createdAt)} · {event.actorName}
                  </option>
                ))}
              </select>
            </label>

            {selected && (
              <article className="min-w-0 space-y-2" data-testid="knowledge-base-history-preview">
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary">{EVENT_OP_LABELS[selected.op]}</Badge>
                  <span
                    className="min-w-0 truncate font-mono"
                    title={
                      selected.op === 'MOVE' && selected.fromPath
                        ? `${selected.fromPath} → ${selected.path}`
                        : selected.path
                    }
                    data-testid="knowledge-base-history-path"
                  >
                    {selected.op === 'MOVE' && selected.fromPath
                      ? `${selected.fromPath} → ${selected.path}`
                      : selected.path}
                  </span>
                  <span className="shrink-0">· {selected.actorName}</span>
                  <span className="shrink-0">· {formatDateTime(selected.createdAt)}</span>
                </div>
                <h2 className="min-w-0 wrap-anywhere text-lg font-semibold">{selected.title}</h2>
                {selected.description.length > 0 && (
                  <p className="min-w-0 wrap-anywhere text-sm text-muted-foreground">
                    {selected.description}
                  </p>
                )}
                {selected.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {selected.tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="max-w-full truncate">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="min-w-0 wrap-anywhere text-sm leading-6">
                  <MarkdownContent content={selected.content} />
                </div>
              </article>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
