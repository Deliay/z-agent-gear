import { useLocation, useNavigate } from 'react-router-dom';
import {
  BookOpen,
  CreditCard,
  GitBranch,
  Home,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  Settings,
} from 'lucide-react';
import type { ContextDomainKey } from '@/lib/sidebar-prefs';

export type RailKey = 'home' | ContextDomainKey | 'billing' | 'settings';

export interface ActivityRailProps {
  /** 当前唯一激活的一级导航项（保证任意时刻至多高亮 1 个） */
  activeRailKey?: RailKey;
  /** 兼容旧调用方：当前聚焦的二级面板分区 */
  activeSection?: ContextDomainKey | null;
  /** 点击一级领域入口时回调（自动展开并切换二级面板专属视图） */
  onSelectSection: (section: ContextDomainKey) => void;
  /** 二级上下文面板是否处于折叠收起状态 */
  collapsed: boolean;
  /** 切换二级上下文面板折叠状态（⌘B） */
  onToggleCollapse: () => void;
  /** 是否存在待用户处理的 Review 或待办交互 */
  hasPendingAttention?: boolean;
  /** 在线主机数量（底部状态徽标，展示型计数） */
  onlineHostCount?: number;
}

const DOMAIN_ITEMS: Array<{
  key: ContextDomainKey;
  label: string;
  icon: typeof MessageSquare;
}> = [
  { key: 'sessions', label: '会话', icon: MessageSquare },
  { key: 'workflows', label: '工作流', icon: GitBranch },
  { key: 'knowledgeBases', label: '知识库', icon: BookOpen },
  { key: 'hosts', label: '主机', icon: Server },
];

/** 当前激活领域的 2px 品牌色指示条（规范 §5 ActivityRail） */
function ActiveIndicator() {
  return (
    <span
      data-testid="rail-active-indicator"
      aria-hidden="true"
      className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-primary"
    />
  );
}

/** 根据路由与显式聚焦状态派生唯一激活项（杜绝双高亮） */
function resolveActiveRailKey(
  pathname: string,
  activeRailKey?: RailKey,
  activeSection?: ContextDomainKey | null,
): RailKey {
  if (activeRailKey) return activeRailKey;
  if (activeSection) return activeSection;
  if (pathname.startsWith('/billing')) return 'billing';
  if (pathname.startsWith('/settings')) return 'settings';
  if (pathname.startsWith('/sessions')) return 'sessions';
  if (pathname.startsWith('/workflows')) return 'workflows';
  if (pathname.startsWith('/knowledge-bases')) return 'knowledgeBases';
  return 'home';
}

/**
 * 三层工作区架构之一级导航轨（Activity Rail，56px 固定窄轨，Surface-0 `bg-rail`）：
 * - 顶部：工作台概览（Home）与四大核心工作域（会话 / 工作流 / 知识库 / 主机）
 * - 底部：在线主机计数、二级列表栏折叠开关（⌘B）、费用中心（Billing）与设置中心（Settings）
 */
export default function ActivityRail({
  activeRailKey,
  activeSection,
  onSelectSection,
  collapsed,
  onToggleCollapse,
  hasPendingAttention = false,
  onlineHostCount = 0,
}: ActivityRailProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const resolvedActive = resolveActiveRailKey(location.pathname, activeRailKey, activeSection);

  const isHome = resolvedActive === 'home';
  const isBilling = resolvedActive === 'billing';
  const isSettings = resolvedActive === 'settings';

  const buttonClass = (selected: boolean) =>
    `relative flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-lg text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
      selected
        ? 'bg-card font-medium text-primary shadow-2xs ring-1 ring-sidebar-border'
        : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
    }`;

  return (
    <aside
      data-testid="activity-rail"
      aria-label="一级导航轨"
      className="flex h-screen w-14 shrink-0 flex-col items-center justify-between border-r border-sidebar-border bg-rail py-3 text-sidebar-foreground select-none"
    >
      <div className="flex w-full flex-col items-center gap-1.5 px-1.5">
        <button
          type="button"
          data-testid="rail-item-home"
          title="工作台概览"
          aria-label="工作台概览"
          aria-current={isHome ? 'page' : undefined}
          onClick={() => navigate('/')}
          className={buttonClass(isHome)}
        >
          {isHome && <ActiveIndicator />}
          <Home className="size-4 shrink-0" />
          <span className="text-xs leading-none">概览</span>
        </button>

        <div className="my-0.5 h-px w-8 bg-sidebar-border" />

        {DOMAIN_ITEMS.map(({ key, label, icon: Icon }) => {
          const isSelected = resolvedActive === key;
          const showDot = key === 'sessions' && hasPendingAttention;

          return (
            <button
              key={key}
              type="button"
              data-testid={`rail-item-${key}`}
              title={label}
              aria-label={`聚焦${label}分区`}
              aria-pressed={isSelected}
              onClick={() => onSelectSection(key)}
              className={buttonClass(isSelected)}
            >
              {isSelected && <ActiveIndicator />}
              <Icon className="size-4 shrink-0" />
              <span className="text-xs leading-none">{label}</span>
              {showDot && (
                <span
                  data-testid="rail-attention-dot"
                  title="存在待处理的评审或交互"
                  className="absolute right-1.5 top-1 h-2 w-2 rounded-full bg-warning"
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex w-full flex-col items-center gap-1.5 border-t border-sidebar-border px-1.5 pt-3">
        {onlineHostCount > 0 && (
          <span
            data-testid="rail-online-count"
            title={`${onlineHostCount} 台控制器在线`}
            className="rounded-full bg-sidebar-accent px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
          >
            {onlineHostCount}
          </span>
        )}
        <button
          type="button"
          data-testid="rail-toggle-sidebar"
          title={collapsed ? '展开列表栏 (⌘B)' : '收起列表栏 (⌘B)'}
          aria-label={collapsed ? '展开列表栏' : '收起列表栏'}
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
          className="flex h-9 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>

        <button
          type="button"
          data-testid="rail-item-billing"
          title="我的费用"
          aria-label="我的费用"
          aria-current={isBilling ? 'page' : undefined}
          onClick={() => navigate('/billing')}
          className={buttonClass(isBilling)}
        >
          {isBilling && <ActiveIndicator />}
          <CreditCard className="size-4 shrink-0" />
          <span className="text-xs leading-none">费用</span>
        </button>

        <button
          type="button"
          data-testid="rail-item-settings"
          title="设置中心"
          aria-label="设置中心"
          aria-current={isSettings ? 'page' : undefined}
          onClick={() => navigate('/settings')}
          className={buttonClass(isSettings)}
        >
          {isSettings && <ActiveIndicator />}
          <Settings className="size-4 shrink-0" />
          <span className="text-xs leading-none">设置</span>
        </button>
      </div>
    </aside>
  );
}
