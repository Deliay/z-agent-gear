import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@apollo/client/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useAuth } from '../stores/auth';
import { useIsMobile } from '../hooks/useIsMobile';
import { useUserEventStream } from '../hooks/useUserEventStream';
import Sidebar from '../components/Sidebar';
import { Button } from '../components/ui/button';
import { HarnessLoginDialog } from '../components/harness/HarnessLoginDialog';
import {
  openHarnessLoginDialog,
  resolveHarnessLoginDialog,
} from '../stores/harnessLoginDialog';
import { HOME_OVERVIEW } from '../graphql/home';
import type { HomeOverviewQuery } from '../graphql/types';
import { HomeOverviewContext } from '../stores/homeOverview';

function FullPageSpinner() {
  return (
    <output className="flex h-screen items-center justify-center" aria-label="Loading…">
      <div className="motion-safe:h-8 motion-safe:w-8 motion-safe:animate-spin motion-safe:rounded-full motion-safe:border-4 motion-safe:border-muted motion-safe:border-t-primary" />
      <span className="sr-only">Loading…</span>
    </output>
  );
}

export default function MainLayout() {
  const { user, loading } = useAuth();
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();

  // 首页 + 侧边栏统一数据源：单一查询、单一轮询（15s）
  const {
    data,
    loading: homeLoading,
    error,
    refetch,
  } = useQuery<HomeOverviewQuery>(HOME_OVERVIEW, {
    pollInterval: 15000,
  });

  // 首屏不阻塞布局：聚合数据未就绪时以空数据渲染外壳，数据到达后各区块同批填充；
  // 轮询期间 loading=true 也不会卸载子页面（frontend-rules：Apollo v4 轮询陷阱）
  const homeData = data?.homeOverview ?? null;

  // 用户级 SSE：harness 登录引导即时下发（待办轮询保留为断线兜底）
  useUserEventStream({
    enabled: Boolean(user) && !loading,
    onHarnessLoginRequired: (request) => {
      openHarnessLoginDialog(request);
    },
    onHarnessLoginResolved: (event) => {
      const matched = resolveHarnessLoginDialog(event.requestId);
      if (event.result === 'succeeded') {
        toast.success('Kimi Code 已登录');
      } else if (event.result === 'cancelled') {
        toast.info('Kimi Code 未登录');
      } else if (event.result === 'expired') {
        toast.info('登录未完成，可重试');
      } else {
        toast.error(event.error || 'Kimi Code 登录失败');
      }
      if (matched) void refetch();
    },
  });

  // D-2：云电脑就绪且服务端已建好默认会话时，自动进入该会话。
  // - `startingHosts` 记录本次会话观测到过 STARTING 的主机：即使中间轮询到 RUNNING+null
  //   （历史遗留/补建路径），后续 defaultSessionId 到达仍可补跳（R2-5/R2-21）。
  // - 首次加载已是 RUNNING 的旧主机不跳转；整个页面生命周期只自动进入一次，避免多主机
  //   同轮就绪时 navigate 互相覆盖。
  const startingCloudHosts = useRef<Set<string>>(new Set());
  const navigatedCloudHosts = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const controller of homeData?.controllers ?? []) {
      const cloudHost = controller.type === 'cloud' ? controller.cloudHost : null;
      if (!cloudHost) continue;

      if (cloudHost.status === 'STARTING') {
        startingCloudHosts.current.add(cloudHost.id);
      }
      if (
        cloudHost.status !== 'RUNNING' ||
        !startingCloudHosts.current.has(cloudHost.id) ||
        !cloudHost.defaultSessionId ||
        cloudHost.deletedAt ||
        navigatedCloudHosts.current.size > 0
      ) {
        continue;
      }

      navigatedCloudHosts.current.add(cloudHost.id);
      navigate(`/sessions/${cloudHost.defaultSessionId}`);
    }
  }, [homeData, navigate]);

  if (loading) {
    return <FullPageSpinner />;
  }

  // 整体加载失败：展示全局错误与重试入口，重试仍是一次请求
  if (error && !data) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3" role="alert">
        <p className="text-sm text-destructive">首页数据加载失败</p>
        {error.message && <p className="max-w-md text-xs text-muted-foreground">{error.message}</p>}
        <Button onClick={() => void refetch()}>重试</Button>
      </div>
    );
  }

  let layout: ReactNode;

  // Desktop: keep existing two-column layout (zero changes)
  if (!isMobile) {
    layout = (
      <div className="grid h-screen grid-cols-[280px_1fr]">
        <Sidebar name={user?.name ?? ''} />
        <main className="overflow-auto">
          <Outlet />
        </main>
      </div>
    );
  } else {
    // Mobile: show list or detail based on route
    const path = location.pathname;
    const isSessionDetail = /^\/sessions\/[^/]+$/.test(path);
    const isWorkflowDetail = /^\/workflows\/[^/]+$/.test(path);
    const isSettings = path.startsWith('/settings');

    if (isSessionDetail || isWorkflowDetail || isSettings) {
      layout = (
        <main className="h-screen overflow-auto">
          <Outlet />
        </main>
      );
    } else {
      layout = (
        <div className="h-screen">
          <Sidebar name={user?.name ?? ''} mobile />
        </div>
      );
    }
  }

  return (
    <HomeOverviewContext.Provider value={{ data: homeData, loading: homeLoading, error, refetch }}>
      {layout}
      {/* 全站单例：登录引导弹窗挂在最高层级，不受 Sidebar / NewSessionDialog 挂载影响 */}
      <HarnessLoginDialog />
    </HomeOverviewContext.Provider>
  );
}
