import { Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@apollo/client/react';
import type { ReactNode } from 'react';
import { useAuth } from '../stores/auth';
import { useIsMobile } from '../hooks/useIsMobile';
import Sidebar from '../components/Sidebar';
import { Button } from '../components/ui/button';
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

  // 首页 + 侧边栏统一数据源：单一查询、单一轮询（15s）
  const {
    data,
    loading: homeLoading,
    error,
    refetch,
  } = useQuery<HomeOverviewQuery>(HOME_OVERVIEW, {
    pollInterval: 15000,
  });

  if (loading) {
    return <FullPageSpinner />;
  }

  // 首屏加载态：仅在无数据时占位，轮询期间不卸载子页面
  // （frontend-rules：Apollo v4 若写成 if (loading) 会在每次轮询卸载整页）
  if (homeLoading && !data) {
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

  const homeData = data?.homeOverview ?? null;

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
