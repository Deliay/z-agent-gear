import { useNavigate } from 'react-router-dom';
import { useQuery } from '@apollo/client/react';
import { GET_SESSIONS, GET_CONTROLLERS } from '../graphql/queries';
import type { GetSessionsQuery, GetControllersQuery } from '../graphql/types';
import { getStatusDotColor, STATUS_LABELS } from '../components/session/status-colors';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { MessageSquarePlus, Activity, Server } from 'lucide-react';

export default function HomePage() {
  const navigate = useNavigate();
  const { data: sessionsData } = useQuery<GetSessionsQuery>(GET_SESSIONS, {
    pollInterval: 15000,
  });
  const { data: controllersData } = useQuery<GetControllersQuery>(GET_CONTROLLERS, {
    pollInterval: 15000,
  });

  const sessions = sessionsData?.sessions ?? [];
  const controllers = controllersData?.controllers ?? [];
  const onlineControllers = controllers.filter((c) => c.status === 'online');

  const recentSessions = [...sessions]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5);

  return (
    <div id="main-content" className="p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-foreground">欢迎使用 Agent Gear</h1>
        <p className="mt-1 text-sm text-muted-foreground">管理你的 Agent 会话、工作区和服务</p>
      </div>

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Activity className="size-4" />
            在线控制器
          </div>
          <p className="mt-2 text-2xl font-semibold text-foreground">{onlineControllers.length}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageSquarePlus className="size-4" />
            会话总数
          </div>
          <p className="mt-2 text-2xl font-semibold text-foreground">{sessions.length}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Server className="size-4" />
            控制器总数
          </div>
          <p className="mt-2 text-2xl font-semibold text-foreground">{controllers.length}</p>
        </div>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">最近会话</h2>
        <Button size="xs" onClick={() => navigate('/sessions')}>
          查看全部
        </Button>
      </div>

      {recentSessions.length === 0 ? (
        <EmptyState
          icon={MessageSquarePlus}
          title="暂无会话"
          description="创建一个新会话开始使用"
          action={
            <Button onClick={() => navigate('/sessions')}>
              新建会话
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {recentSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => navigate(`/sessions/${session.id}`)}
              className="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent"
            >
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${getStatusDotColor(session.status)}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {session.title || '新会话'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {STATUS_LABELS[session.status] ?? session.status}
                </div>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {new Date(session.updatedAt).toLocaleDateString('zh-CN')}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
