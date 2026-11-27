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
import type { SidebarSectionKey } from '@/lib/sidebar-prefs';

export interface ActivityRailProps {
  /** 当前聚焦的二级面板分区 */
  activeSection?: SidebarSectionKey | null;
  /** 点击一级领域入口时回调（自动展开并聚焦二级面板对应分区） */
  onSelectSection: (section: SidebarSectionKey) => void;
  /** 二级上下文面板是否处于折叠收起状态 */
  collapsed: boolean;
  /** 切换二级上下文面板折叠状态（⌘B） */
  onToggleCollapse: () => void;
  /** 是否存在待用户处理的 Review 或待办交互 */
  hasPendingAttention?: boolean;
}

const DOMAIN_ITEMS: Array<{
  key: SidebarSectionKey;
  label: string;
  icon: typeof MessageSquare;
  matchPrefix?: string;
}> = [
  { key: 'sessions', label: '会话', icon: MessageSquare, matchPrefix: '/sessions' },
  { key: 'workflows', label: '工作流', icon: GitBranch, matchPrefix: '/workflows' },
  { key: 'knowledgeBases', label: '知识库', icon: BookOpen, matchPrefix: '/knowledge-bases' },
  { key: 'hosts', label: '主机', icon: Server },
];

/**
 * 三层工作区架构之一级导航轨（Activity Rail，56px 固定窄轨）：
 * - 顶部：工作台概览（Home）与二级列表栏折叠开关（⌘B）
 * - 中部：会话 / 工作流 / 知识库 / 主机 四大核心工作域快速聚焦
 * - 底部：费用中心（Billing）与设置中心（Settings）
 */
export default function ActivityRail({
  activeSection,
  onSelectSection,
  collapsed,
  onToggleCollapse,
  hasPendingAttention = false,
}: ActivityRailProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname;

  const isHome = path === '/';
  const isBilling = path.startsWith('/billing');
  const isSettings = path.startsWith('/settings');

  return (
    <aside
      data-testid="activity-rail"
      aria-label="一级导航轨"
      className="flex h-screen w-14 shrink-0 flex-col items-center justify-between border-r border-sidebar-border bg-sidebar py-3 text-sidebar-foreground select-none"
    >
      <div className="flex w-full flex-col items-center gap-1.5 px-1.5">
        <button
          type="button"
          data-testid="rail-item-home"
          title="工作台概览"
          aria-label="工作台概览"
          onClick={() => navigate('/')}
          className={`flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-lg text-xs transition-colors ${
            isHome
              ? 'bg-card font-medium text-primary shadow-2xs ring-1 ring-sidebar-border'
              : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
          }`}
        >
          <Home className="size-4 shrink-0" />
          <span className="text-xs leading-none">概览</span>
        </button>

        <div className="my-0.5 h-px w-8 bg-sidebar-border" />

        {DOMAIN_ITEMS.map(({ key, label, icon: Icon, matchPrefix }) => {
          const isRouteActive = Boolean(matchPrefix && path.startsWith(matchPrefix));
          const isSelected = activeSection === key || isRouteActive;
          const showDot = key === 'sessions' && hasPendingAttention;

          return (
            <button
              key={key}
              type="button"
              data-testid={`rail-item-${key}`}
              title={label}
              aria-label={`聚焦${label}分区`}
              onClick={() => onSelectSection(key)}
              className={`relative flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-lg text-xs transition-colors ${
                isSelected
                  ? 'bg-card font-medium text-primary shadow-2xs ring-1 ring-sidebar-border'
                  : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
              }`}
            >
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
        <button
          type="button"
          data-testid="rail-toggle-sidebar"
          title={collapsed ? '展开列表栏 (⌘B)' : '收起列表栏 (⌘B)'}
          aria-label={collapsed ? '展开列表栏' : '收起列表栏'}
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
          className="flex h-9 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>

        <button
          type="button"
          data-testid="rail-item-billing"
          title="我的费用"
          aria-label="我的费用"
          onClick={() => navigate('/billing')}
          className={`flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-lg text-xs transition-colors ${
            isBilling
              ? 'bg-card font-medium text-primary shadow-2xs ring-1 ring-sidebar-border'
              : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
          }`}
        >
          <CreditCard className="size-4 shrink-0" />
          <span className="text-xs leading-none">费用</span>
        </button>

        <button
          type="button"
          data-testid="rail-item-settings"
          title="设置中心"
          aria-label="设置中心"
          onClick={() => navigate('/settings')}
          className={`flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-lg text-xs transition-colors ${
            isSettings
              ? 'bg-card font-medium text-primary shadow-2xs ring-1 ring-sidebar-border'
              : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
          }`}
        >
          <Settings className="size-4 shrink-0" />
          <span className="text-xs leading-none">设置</span>
        </button>
      </div>
    </aside>
  );
}
