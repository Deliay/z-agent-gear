import { NavLink } from 'react-router-dom';
import { CreditCard, Settings } from 'lucide-react';
import { TodoListPanel } from '../TodoListPanel';
import ThemeToggle from '../ThemeToggle';

export interface ContextPanelFooterProps {
  /** 当前用户展示名 */
  name: string;
  /** 移动端模式下保留费用与设置直达行 */
  mobile?: boolean;
}

/**
 * 上下文列表栏精简底栏：
 * - 桌面端仅保留「用户名 + 待办提醒 + 主题切换」，移除与 ActivityRail 重复的费用/设置/新建按钮
 * - 移动端保留直达「我的费用」「设置」入口，确保窄屏无入口丢失
 */
export default function ContextPanelFooter({ name, mobile = false }: ContextPanelFooterProps) {
  return (
    <div data-testid="context-panel-footer" className="shrink-0">
      {mobile && (
        <>
          <NavLink
            to="/billing"
            className="flex items-center gap-2 border-t border-sidebar-border px-4 py-2.5 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
          >
            <CreditCard className="size-4 shrink-0" />
            <span>我的费用</span>
          </NavLink>
          <NavLink
            to="/settings"
            className="flex items-center gap-2 border-t border-sidebar-border px-4 py-2.5 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
          >
            <Settings className="size-4 shrink-0" />
            <span>设置</span>
          </NavLink>
        </>
      )}

      <div className="border-t border-sidebar-border px-3 py-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-sidebar-foreground">{name}</span>
          <div className="flex shrink-0 items-center gap-1">
            <TodoListPanel />
            <ThemeToggle />
          </div>
        </div>
      </div>
    </div>
  );
}
