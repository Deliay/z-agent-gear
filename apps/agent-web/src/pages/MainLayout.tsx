import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@apollo/client/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useAuth } from '../stores/auth';
import { useIsMobile } from '../hooks/useIsMobile';
import Sidebar from '../components/Sidebar';
import { Button } from '../components/ui/button';
import { HOME_OVERVIEW } from '../graphql/home';
import type { CloudHostStatus, HomeOverviewQuery } from '../graphql/types';
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

  // D-2：云电脑就绪（STARTING→RUNNING）且服务端已建好默认会话时，自动进入该会话。
  // 只认可观测到的状态迁移，首次加载已是 RUNNING 的旧主机不跳转；每台主机只导航一次。
  const previousCloudHostStatus = useRef<Map<string, CloudHostStatus>>(new Map());
  const navigatedCloudHosts = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const controller of homeData?.controllers ?? []) {
      const cloudHost = controller.type === 'cloud' ? controller.cloudHost : null;
      if (!cloudHost) continue;

      const previousStatus = previousCloudHostStatus.current.get(cloudHost.id);
      previousCloudHostStatus.current.set(cloudHost.id, cloudHost.status);

      if (
        previousStatus !== 'STARTING' ||
        cloudHost.status !== 'RUNNING' ||
        !cloudHost.defaultSessionId ||
        cloudHost.deletedAt ||
        navigatedCloudHosts.current.has(cloudHost.id)
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
        <Sidebar username={user?.username ?? ''} />
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
          <Sidebar username={user?.username ?? ''} mobile />
        </div>
      );
    }
  }

  return (
    <HomeOverviewContext.Provider value={{ data: homeData, loading: homeLoading, error, refetch }}>
      {layout}
    </HomeOverviewContext.Provider>
  );
}
