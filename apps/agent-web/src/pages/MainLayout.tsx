import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@apollo/client/react';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CreditCard, GitBranch, Home, MessageSquare, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../stores/auth';
import { useIsMobile } from '../hooks/useIsMobile';
import { useUserEventStream } from '../hooks/useUserEventStream';
import Sidebar from '../components/Sidebar';
import SidebarResizer from '../components/SidebarResizer';
import ActivityRail, { type RailKey } from '../components/layout/ActivityRail';
import QuickCreatePanel from '../components/layout/QuickCreatePanel';
import { readSidebarWidth } from '../lib/sidebar-width';
import {
  domainFromPathname,
  persistActiveDomain,
  persistSidebarCollapsed,
  readActiveDomain,
  readSidebarCollapsed,
  type ContextDomainKey,
} from '../lib/sidebar-prefs';
import { Button } from '../components/ui/button';
import { HarnessLoginDialog } from '../components/harness/HarnessLoginDialog';
import {
  openHarnessLoginDialog,
  resolveHarnessLoginDialog,
} from '../stores/harnessLoginDialog';
import { HOME_OVERVIEW } from '../graphql/home';
import type { HomeOverviewQuery } from '../graphql/types';
import { HomeOverviewContext } from '../stores/homeOverview';
import { useWorkspaceContextSync } from '../hooks/useWorkspaceContextSync';

/** 工作区上下文同步桥：必须在 HomeOverviewContext.Provider 内（消费聚合数据）。 */
function WorkspaceContextSyncBridge() {
  useWorkspaceContextSync();
  return null;
}

function FullPageSpinner() {
  return (
    <output className="flex h-screen items-center justify-center" aria-label="加载中…">
      <div className="motion-safe:h-8 motion-safe:w-8 motion-safe:animate-spin motion-safe:rounded-full motion-safe:border-4 motion-safe:border-muted motion-safe:border-t-primary" />
      <span className="sr-only">加载中…</span>
    </output>
  );
}

export default function MainLayout() {
  const { user, loading } = useAuth();
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();

  // 侧边栏宽度：本地记忆（localStorage['sidebar-width']），默认 280px
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  // 二级列表栏折叠状态（⌘B / Ctrl+B 切换并持久化）
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  // 当前聚焦领域（持久化 + 随路由前缀自动同步）
  const [activeDomain, setActiveDomain] = useState<ContextDomainKey>(() => {
    return domainFromPathname(location.pathname) ?? readActiveDomain();
  });
  // 记录用户在概览/费用/设置页显式点击某个领域图标时的临时高亮覆盖，路由变化时清空
  const [railOverride, setRailOverride] = useState<ContextDomainKey | null>(null);

  useEffect(() => {
    setRailOverride(null);
    const routeDomain = domainFromPathname(location.pathname);
    if (routeDomain) {
      setActiveDomain(routeDomain);
      persistActiveDomain(routeDomain);
    }
  }, [location.pathname]);

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      persistSidebarCollapsed(next);
      return next;
    });
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setSidebarCollapsed((prev) => {
          const next = !prev;
          persistSidebarCollapsed(next);
          return next;
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
  const homeContextValue = { data: homeData, loading: homeLoading, error, refetch };

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
    // Review 创建/终态：刷新侧边栏 Review 分区（T-RSEC 实时性）
    onSessionReview: () => {
      void refetch();
    },
  });

  // D-2：云电脑就绪且服务端已建好默认会话时，自动进入该会话。
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

  // 登录后先渲染错误/加载页也必须挂载同步桥：持久化工作区失效时由 hook 清理并 refetch
  if (loading) {
    return (
      <HomeOverviewContext.Provider value={homeContextValue}>
        <WorkspaceContextSyncBridge />
        <FullPageSpinner />
      </HomeOverviewContext.Provider>
    );
  }

  // 整体加载失败：展示全局错误与重试入口，重试仍是一次请求
  if (error && !data) {
    return (
      <HomeOverviewContext.Provider value={homeContextValue}>
        <WorkspaceContextSyncBridge />
        <div className="flex h-screen flex-col items-center justify-center gap-3" role="alert">
          <p className="text-sm text-destructive-text">首页数据加载失败</p>
          {error.message && <p className="max-w-md text-xs text-muted-foreground">{error.message}</p>}
          <Button onClick={() => void refetch()}>重试</Button>
        </div>
      </HomeOverviewContext.Provider>
    );
  }

  const onlineControllerCount = (homeData?.controllers ?? []).filter((controller) => controller.status === 'online').length;

  const hasPendingAttention =
    (homeData?.unreadTodoCount ?? 0) > 0 ||
    (homeData?.sessionReviews ?? []).some((review) => review.status === 'PENDING');

  const handleSelectRailDomain = (domain: ContextDomainKey) => {
    setSidebarCollapsed(false);
    persistSidebarCollapsed(false);
    setActiveDomain(domain);
    persistActiveDomain(domain);
    setRailOverride(domain);
  };

  // 严格派生唯一激活项（杜绝双高亮）
  const activeRailKey: RailKey = (() => {
    if (railOverride) return railOverride;
    const path = location.pathname;
    if (path === '/') return 'home';
    if (path.startsWith('/billing')) return 'billing';
    if (path.startsWith('/settings')) return 'settings';
    return domainFromPathname(path) ?? activeDomain;
  })();

  let layout: ReactNode;

  // Desktop: 三层工作区外壳（56px Surface-0 ActivityRail + Surface-1 领域聚焦 ContextPanel + 主舞台）
  if (!isMobile) {
    layout = (
      <div
        className={`relative grid h-screen ${
          sidebarCollapsed
            ? 'grid-cols-[3.5rem_minmax(0,1fr)]'
            : 'grid-cols-[3.5rem_var(--sidebar-width,17.5rem)_minmax(0,1fr)]'
        }`}
        style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
      >
        <ActivityRail
          activeRailKey={activeRailKey}
          onSelectSection={handleSelectRailDomain}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebarCollapsed}
          hasPendingAttention={hasPendingAttention}
          onlineHostCount={onlineControllerCount}
        />
        {!sidebarCollapsed && (
          <>
            <Sidebar
              name={user?.name ?? ''}
              activeDomain={activeDomain}
              onSelectDomain={handleSelectRailDomain}
            />
            <SidebarResizer width={sidebarWidth} offsetLeft={56} onWidthChange={setSidebarWidth} />
          </>
        )}
        <main id="main-content" className="min-w-0 overflow-auto">
          <Outlet />
        </main>
      </div>
    );
  } else {
    // Mobile: 列表路由（/、/sessions）全屏展示 Sidebar；其余所有激活路由渲染 <Outlet />
    const path = location.pathname;
    const isListRoute = path === '/' || path === '/sessions';

    const content = !isListRoute ? (
      <main id="main-content" className="h-full overflow-auto">
        <Outlet />
      </main>
    ) : (
      <main id="main-content" className="h-full">
        <Sidebar
          name={user?.name ?? ''}
          mobile
          activeDomain={activeDomain}
          onSelectDomain={handleSelectRailDomain}
        />
      </main>
    );

    const mobileNavItems = [
      {
        key: 'home',
        label: '概览',
        icon: Home,
        active: path === '/' && activeDomain !== 'workflows',
        onClick: () => {
          if (activeDomain === 'workflows') {
            handleSelectRailDomain('sessions');
          }
          navigate('/');
        },
      },
      {
        key: 'sessions',
        label: '会话',
        icon: MessageSquare,
        active: path.startsWith('/sessions'),
        onClick: () => {
          handleSelectRailDomain('sessions');
          navigate('/sessions');
        },
      },
      {
        key: 'workflows',
        label: '工作流',
        icon: GitBranch,
        active: path.startsWith('/workflows') || (path === '/' && activeDomain === 'workflows'),
        onClick: () => {
          handleSelectRailDomain('workflows');
          if (!isListRoute) {
            navigate('/');
          }
        },
      },
      {
        key: 'billing',
        label: '费用',
        icon: CreditCard,
        active: path.startsWith('/billing'),
        onClick: () => navigate('/billing'),
      },
      {
        key: 'settings',
        label: '设置',
        icon: Settings,
        active: path.startsWith('/settings'),
        onClick: () => navigate('/settings'),
      },
    ];

    layout = (
      <div className="flex h-screen flex-col">
        <div className="min-h-0 flex-1">{content}</div>
        <nav
          aria-label="移动端主导航"
          data-testid="mobile-bottom-nav"
          className="flex h-14 shrink-0 items-center justify-around border-t border-border bg-background px-2 pb-[env(safe-area-inset-bottom)]"
        >
          {mobileNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                data-testid={`mobile-nav-${item.key}`}
                aria-current={item.active ? 'page' : undefined}
                onClick={item.onClick}
                className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-2 py-1.5 text-center text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  item.active
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate leading-none">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    );
  }

  return (
    <HomeOverviewContext.Provider value={homeContextValue}>
      <WorkspaceContextSyncBridge />
      {layout}
      {/* 全站单例：登录引导弹窗挂在最高层级，不受 Sidebar / NewSessionDialog 挂载影响 */}
      <HarnessLoginDialog />
      {/* ⌘K / Ctrl+K 全局快速新建（D6） */}
      <QuickCreatePanel />
    </HomeOverviewContext.Provider>
  );
}
