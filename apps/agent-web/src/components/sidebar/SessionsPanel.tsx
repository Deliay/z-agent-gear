import { useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@apollo/client/react';
import { Archive, ChevronDown, ChevronRight } from 'lucide-react';
import { GET_ARCHIVED_SESSIONS } from '@/graphql/queries';
import type {
  GetArchivedSessionsQuery,
  HomeOverviewControllerData,
  SessionData,
  SessionReviewSummaryData,
} from '@/graphql/types';
import { getStatusDotColor } from '../session/status-colors';
import ReviewSection from './ReviewSection';
import { sortByUpdatedAtDesc } from '@/lib/sidebar-prefs';

export interface SessionsPanelProps {
  sessions: SessionData[];
  controllers: HomeOverviewControllerData[];
  sessionReviews: SessionReviewSummaryData[];
  filterQuery: string;
  onClearFilter: () => void;
  resolveWorkspaceName: (session: SessionData) => string;
}

/** 会话条目（活跃列表与已归档分组共用同一两行卡片结构） */
function SessionListEntry({
  session,
  title,
  resolveWorkspaceName,
}: {
  session: SessionData;
  title: string | undefined;
  resolveWorkspaceName: (session: SessionData) => string;
}) {
  const wsName = resolveWorkspaceName(session);
  const displayTitle = session.title || '未命名会话';
  return (
    <li>
      <NavLink
        to={`/sessions/${session.id}`}
        title={title}
        className={({ isActive }) =>
          `flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            isActive
              ? 'bg-sidebar-accent font-medium text-sidebar-foreground'
              : 'text-sidebar-foreground hover:bg-sidebar-accent/70'
          }`
        }
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${getStatusDotColor(session.status)}`} />
        <div className="min-w-0 flex-1">
          <div className="truncate">{displayTitle}</div>
          <div className="truncate text-xs text-muted-foreground">
            {wsName || <span className="text-muted-foreground/60">未知工作区</span>}
          </div>
        </div>
      </NavLink>
    </li>
  );
}

/** 已归档会话：常驻折叠、无计数、首次点击展开按需懒加载 */
function ArchivedSessionGroup({
  controllers,
  resolveWorkspaceName,
}: {
  controllers: Array<{ id: string; name: string; hostname: string }>;
  resolveWorkspaceName: (session: SessionData) => string;
}) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const { data, loading, error, refetch } = useQuery<GetArchivedSessionsQuery>(GET_ARCHIVED_SESSIONS, {
    skip: !archivedOpen,
    fetchPolicy: 'cache-and-network',
  });
  const sessions = sortByUpdatedAtDesc(
    (data?.sessions ?? []).map((session) => ({ ...session, updatedAt: session.updatedAt ?? '' })),
  );

  return (
    <div className="shrink-0 border-t border-sidebar-border px-2 py-1.5">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setArchivedOpen((prev) => !prev)}
        aria-expanded={archivedOpen}
      >
        {archivedOpen ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <Archive className="size-3.5 shrink-0" />
        <span>已归档</span>
      </button>
      {archivedOpen && (
        <div className="mt-1 max-h-48 overflow-y-auto pl-2">
          {loading && sessions.length === 0 ? (
            <p className="px-2.5 py-1.5 text-xs text-muted-foreground">加载中…</p>
          ) : error ? (
            <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
              加载失败
              <button
                type="button"
                className="ml-2 underline hover:text-foreground"
                onClick={() => void refetch()}
              >
                重试
              </button>
            </div>
          ) : sessions.length === 0 ? (
            <p className="px-2.5 py-1.5 text-xs text-muted-foreground">暂无归档</p>
          ) : (
            <ul className="space-y-0.5" data-testid="sidebar-archived-session-list">
              {sessions.map((session) => {
                const controller = controllers.find((item) => item.id === session.controllerId);
                return (
                  <SessionListEntry
                    key={session.id}
                    session={session}
                    title={
                      controller
                        ? `${session.title || '未命名会话'} · ${controller.name || controller.hostname}`
                        : undefined
                    }
                    resolveWorkspaceName={resolveWorkspaceName}
                  />
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** 会话领域专视图：置顶 Review 提醒 + 本地筛选后的活跃会话列表 + 底部按需归档 */
export default function SessionsPanel({
  sessions,
  controllers,
  sessionReviews,
  filterQuery,
  onClearFilter,
  resolveWorkspaceName,
}: SessionsPanelProps) {
  const sortedSessions = useMemo(
    () => sortByUpdatedAtDesc(sessions.map((session) => ({ ...session, updatedAt: session.updatedAt ?? '' }))),
    [sessions],
  );

  const normalizedQuery = filterQuery.trim().toLowerCase();
  const filteredSessions = useMemo(() => {
    if (!normalizedQuery) return sortedSessions;
    return sortedSessions.filter((session) => {
      const title = (session.title || '未命名会话').toLowerCase();
      const wsName = resolveWorkspaceName(session).toLowerCase();
      return title.includes(normalizedQuery) || wsName.includes(normalizedQuery);
    });
  }, [sortedSessions, normalizedQuery, resolveWorkspaceName]);

  return (
    <div
      data-testid="context-panel-domain-sessions"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <ReviewSection sessionReviews={sessionReviews} />

        {filteredSessions.length === 0 && normalizedQuery ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            <p>未找到匹配的会话</p>
            <button
              type="button"
              onClick={onClearFilter}
              className="mt-2 text-primary hover:underline"
            >
              清空筛选
            </button>
          </div>
        ) : filteredSessions.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">暂无活跃会话</p>
        ) : (
          <ul className="space-y-0.5" data-testid="sidebar-session-list">
            {filteredSessions.map((session) => {
              const controller = controllers.find((item) => item.id === session.controllerId);
              return (
                <SessionListEntry
                  key={session.id}
                  session={session}
                  title={
                    controller
                      ? `${session.title || '未命名会话'} · ${controller.name || controller.hostname}`
                      : undefined
                  }
                  resolveWorkspaceName={resolveWorkspaceName}
                />
              );
            })}
          </ul>
        )}
      </div>

      <ArchivedSessionGroup
        controllers={controllers}
        resolveWorkspaceName={resolveWorkspaceName}
      />
    </div>
  );
}
