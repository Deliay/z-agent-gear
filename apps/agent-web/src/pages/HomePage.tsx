import { useNavigate } from 'react-router-dom';
import { useHomeOverview } from '../stores/homeOverview';
import { getStatusDotColor, STATUS_LABELS } from '../components/session/status-colors';
import { workflowNodeStatusVisual } from '../lib/status-matrix';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { MessageSquarePlus, Activity, Server, Workflow, ClipboardCheck, GitPullRequest } from 'lucide-react';

export default function HomePage() {
  const navigate = useNavigate();
  // 首屏数据由 MainLayout 的 HOME_OVERVIEW 统一下传，此处不再独立查询
  const { data } = useHomeOverview();

  const sessions = data?.sessions ?? [];
  const controllers = data?.controllers ?? [];
  const sessionTotalCount = data?.sessionTotalCount ?? sessions.length;
  const onlineControllers = controllers.filter((c) => c.status === 'online');

  const recentSessions = [...sessions]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5);

  // 工作流与协同动态区：全部消费 HOME_OVERVIEW（零新增查询）
  const workflowInstances = [...(data?.workflowInstances ?? [])]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 4);
  const pendingTodos = (data?.todos ?? []).filter((todo) => !todo.resolvedAt);
  const pendingReviews = (data?.sessionReviews ?? []).filter((review) => review.status === 'PENDING');

  return (
    <div id="main-content" className="p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-foreground">欢迎使用 Agent Gear</h1>
        <p className="mt-1 text-sm text-muted-foreground">管理你的 Agent 会话、工作区和服务</p>
      </div>

      <div className="mb-8 grid gap-4 sm:grid-cols-3" data-testid="home-kpi-grid">
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Activity className="size-4" />
            在线控制器
          </div>
          <p data-testid="home-kpi-online" className="mt-2 text-2xl font-semibold text-foreground tabular-nums">{onlineControllers.length}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageSquarePlus className="size-4" />
            会话总数
          </div>
          <p data-testid="home-kpi-sessions" className="mt-2 text-2xl font-semibold text-foreground tabular-nums">{sessionTotalCount}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Server className="size-4" />
            控制器总数
          </div>
          <p data-testid="home-kpi-controllers" className="mt-2 text-2xl font-semibold text-foreground tabular-nums">{controllers.length}</p>
        </div>
      </div>

      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border bg-card p-4" data-testid="home-dynamic-workflow">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Workflow className="size-4 text-muted-foreground" />
              工作流动态
            </h2>
            <Button size="xs" variant="ghost" onClick={() => navigate('/workflows')}>查看全部</Button>
          </div>
          {workflowInstances.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无进行中的工作流</p>
          ) : (
            <ul className="space-y-1.5">
              {workflowInstances.map((instance) => (
                <li key={instance.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/workflows/${instance.id}`)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                  >
                    <span
                      aria-hidden="true"
                      className={`size-2 shrink-0 rounded-full ${
                        workflowNodeStatusVisual(instance.currentNodeNames.length > 0 ? 'RUNNING' : (instance.lastNodeStatus ?? 'INITIALIZING')).dot
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-foreground">{instance.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {instance.currentNodeNames[0] ?? instance.lastNodeName ?? '未开始'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border bg-card p-4" data-testid="home-dynamic-collab">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ClipboardCheck className="size-4 text-muted-foreground" />
              协同待处理
            </h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {pendingTodos.length + pendingReviews.length} 项
            </span>
          </div>
          {pendingTodos.length === 0 && pendingReviews.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无待处理的提问、审批与评审</p>
          ) : (
            <ul className="space-y-1.5">
              {pendingReviews.slice(0, 3).map((review) => (
                <li key={review.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/sessions/${review.sessionId}?review=${encodeURIComponent(review.id)}`)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                  >
                    <GitPullRequest className="size-3.5 shrink-0 text-warning-text" />
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      待评审：{review.sessionTitle || review.files[0] || '会话内容'}
                    </span>
                  </button>
                </li>
              ))}
              {pendingTodos.slice(0, 3).map((todo) => (
                <li key={todo.id}>
                  <button
                    type="button"
                    onClick={() => navigate('/sessions')}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                  >
                    <ClipboardCheck className="size-3.5 shrink-0 text-info-text" />
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      待处理：{todo.title || '会话交互'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
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
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {new Date(session.updatedAt).toLocaleDateString('zh-CN')}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
