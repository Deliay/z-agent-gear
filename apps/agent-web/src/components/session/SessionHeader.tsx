import { useLayoutEffect, useRef, useState } from 'react';
import { getStatusBadgeClass, STATUS_LABELS } from './status-colors';
import { useIsMobile } from '../../hooks/useIsMobile';
import MobileBackButton from '../MobileBackButton';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPopup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';
import { GitFork, Info, Loader2, Download, Archive, ArchiveRestore, MessageSquare, Columns2, Rows2, Activity, MoreHorizontalIcon, Play, Trash2, X } from 'lucide-react';
import { AgentCapabilityPanel } from './AgentCapabilityPanel';
import type { AgentCapabilitiesController } from '../../hooks/useAgentCapabilities';
import type { SessionData } from '../../graphql/types';
import { harnessLabel } from '../../lib/harness-labels';
import { cn } from '../../lib/utils';
import type { SplitMode } from '../../lib/split-prefs';

interface Session {
  id: string;
  userId: string;
  controllerId: string;
  controllerName: string;
  acpServerType: string;
  status: string;
  externalSessionId: string | null;
  cwd: string | null;
  worktreePath?: string | null;
  /** 归档状态（true=已归档，展示「已归档」徽标并把入口切换为「取消归档」） */
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

function truncatePathLeft(path: string, maxLen = 40): string {
  if (path.length > maxLen) {
    return '...' + path.slice(-(maxLen - 3));
  }
  return path;
}

/** 工具栏收纳阈值：为标题/状态信息区预留的最小宽度（px），不足以容纳完整工具栏时收成省略号下拉 */
const TOOLBAR_MIN_INFO_WIDTH = 192;

interface SessionHeaderProps {
  session: Session | null;
  status: string;
  onClose: () => void;
  onDelete: () => void;
  onContinue?: () => void;
  resuming?: boolean;
  closing?: boolean;
  deleting?: boolean;
  controllerOnline?: boolean;
  /** 会话能力门控（缺省 = 未知能力，全部放行） */
  capabilities?: AgentCapabilitiesController;
  /** 能力面板数据源（完整 Session，含快照与 features） */
  capabilitySession?: SessionData | null;
  /** 统一只读（readOnlyReason 非空）：隐藏「继续」/恢复入口 */
  readOnly?: boolean;
  /** 导出对话为 Markdown */
  onExport?: () => void;
  /** 归档/取消归档；不传则不渲染入口（工作流节点会话由上层不传） */
  onArchiveToggle?: () => void;
  /** 归档/取消归档进行中（按钮禁用） */
  archiving?: boolean;
  /** 分屏布局模式（chat/horizontal/vertical；偏好按会话记忆） */
  splitMode?: SplitMode;
  onSplitModeChange?: (mode: SplitMode) => void;
  /** 实况跟随开关（仅非 chat 渲染） */
  live?: boolean;
  onLiveChange?: (live: boolean) => void;
  /** 宽度门控：不足 1024px 隐藏「左右分栏」入口 */
  wideEnoughForHorizontal?: boolean;
}

export default function SessionHeader({ session, status, onClose, onDelete, onContinue, resuming, closing, deleting, controllerOnline, capabilities, capabilitySession, readOnly, onExport, onArchiveToggle, archiving, splitMode, onSplitModeChange, live, onLiveChange, wideEnoughForHorizontal }: SessionHeaderProps) {
  const isMobile = useIsMobile();
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  /** 完整工具栏最近一次测得的自然宽度（收纳后 toolbar 不在 DOM，用它判定恢复） */
  const toolbarNaturalWidthRef = useRef(0);
  const [toolbarOverflow, setToolbarOverflow] = useState(false);

  const continueBlocked = (capabilities?.isBlocked('session.resume') ?? false)
    && (capabilities?.isBlocked('session.load') ?? false);
  const continueDisabled = resuming || !controllerOnline || continueBlocked;

  const showSplitOptions = Boolean(onSplitModeChange && splitMode);
  const showClose = status !== 'ended' && status !== 'creating' && status !== 'disconnected' && !resuming;
  const showContinue = (status === 'ended' || status === 'disconnected' || resuming) && !readOnly;

  // 工具栏溢出收纳：标题栏宽度不足以容纳完整工具栏（为信息区预留 TOOLBAR_MIN_INFO_WIDTH）时，
  // 工具栏整体收成省略号按钮，点击展开 icon+文字下拉。jsdom 无布局（clientWidth 恒 0）时保持展开，
  // 组件测试经 stub 宽度 + window resize 事件驱动测量。
  useLayoutEffect(() => {
    const measure = () => {
      const header = headerRef.current;
      if (!header) return;
      const headerWidth = header.clientWidth;
      if (!headerWidth) return;
      const toolbar = toolbarRef.current;
      if (toolbar) {
        const natural = toolbar.scrollWidth;
        if (natural > 0) toolbarNaturalWidthRef.current = natural;
      }
      const natural = toolbarNaturalWidthRef.current;
      if (!natural) return;
      const shouldCollapse = natural > headerWidth - TOOLBAR_MIN_INFO_WIDTH;
      setToolbarOverflow((prev) => (prev === shouldCollapse ? prev : shouldCollapse));
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' && headerRef.current
      ? new ResizeObserver(measure)
      : null;
    if (observer && headerRef.current) observer.observe(headerRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  });

  return (
    <div ref={headerRef} className="flex items-center justify-between gap-2 border-b border-border bg-background px-4 py-3" data-testid="session-header">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
        {isMobile && <MobileBackButton to="/sessions" />}
        <h1 className="truncate text-lg font-semibold">
          {session?.controllerName || 'Session'}
        </h1>
        <span data-testid="session-status-badge" className={`rounded-full px-2 py-1 text-xs font-medium ${getStatusBadgeClass(status)}`}>
          {STATUS_LABELS[status] ?? status}
        </span>
        {session?.archived && (
          <span data-testid="session-archived-badge" className="rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
            已归档
          </span>
        )}
        {session?.acpServerType && !isMobile && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {harnessLabel(session.acpServerType)}
          </span>
        )}
        {session?.cwd && !isMobile && (
          <div className="flex items-center gap-1">
            <span className="text-sm text-muted-foreground font-mono" title={session.cwd}>{truncatePathLeft(session.cwd)}</span>
            {session?.worktreePath && !isMobile && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary font-medium flex items-center gap-1">
                <GitFork className="size-2.5" />
                Worktree
              </span>
            )}
          </div>
        )}
        {session?.createdAt && (
          <span className="text-xs text-muted-foreground">
            {new Date(session.createdAt).toLocaleString()}
          </span>
        )}
      </div>
      {toolbarOverflow ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" aria-label="更多操作" data-testid="session-header-overflow" />}
          >
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuPopup data-testid="session-header-overflow-menu">
            <DropdownMenuItem data-testid="overflow-capabilities" onClick={() => setCapabilityOpen(true)}>
              <Info className="size-4" />
              能力清单
            </DropdownMenuItem>
            {showSplitOptions && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  data-testid="overflow-split-mode-chat"
                  onClick={() => onSplitModeChange?.('chat')}
                  className={cn(splitMode === 'chat' && 'bg-secondary font-medium text-secondary-foreground')}
                >
                  <MessageSquare className="size-4" />
                  仅会话
                </DropdownMenuItem>
                {wideEnoughForHorizontal !== false && (
                  <DropdownMenuItem
                    data-testid="overflow-split-mode-horizontal"
                    onClick={() => onSplitModeChange?.('horizontal')}
                    className={cn(splitMode === 'horizontal' && 'bg-secondary font-medium text-secondary-foreground')}
                  >
                    <Columns2 className="size-4" />
                    左右分栏
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  data-testid="overflow-split-mode-vertical"
                  onClick={() => onSplitModeChange?.('vertical')}
                  className={cn(splitMode === 'vertical' && 'bg-secondary font-medium text-secondary-foreground')}
                >
                  <Rows2 className="size-4" />
                  上下分栏
                </DropdownMenuItem>
                {splitMode !== 'chat' && onLiveChange && (
                  <DropdownMenuItem
                    data-testid="overflow-live-toggle"
                    onClick={() => onLiveChange(!live)}
                    className={cn(live && 'bg-secondary font-medium text-secondary-foreground')}
                  >
                    <Activity className="size-4" />
                    实况跟随
                  </DropdownMenuItem>
                )}
              </>
            )}
            {(onExport || onArchiveToggle) && <DropdownMenuSeparator />}
            {onExport && (
              <DropdownMenuItem data-testid="overflow-export" onClick={onExport}>
                <Download className="size-4" />
                导出对话
              </DropdownMenuItem>
            )}
            {onArchiveToggle && (
              <DropdownMenuItem
                data-testid="overflow-archive"
                onClick={onArchiveToggle}
                disabled={archiving}
              >
                {archiving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : session?.archived ? (
                  <ArchiveRestore className="size-4" />
                ) : (
                  <Archive className="size-4" />
                )}
                {archiving ? '归档中...' : session?.archived ? '取消归档' : '归档'}
              </DropdownMenuItem>
            )}
            {(showClose || showContinue) && <DropdownMenuSeparator />}
            {showClose && (
              <DropdownMenuItem
                data-testid="overflow-close"
                onClick={onClose}
                disabled={closing}
                className="text-destructive"
              >
                {closing ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
                {closing ? '关闭中...' : '关闭'}
              </DropdownMenuItem>
            )}
            {showContinue && (
              <DropdownMenuItem
                data-testid="overflow-continue"
                onClick={() => onContinue?.()}
                disabled={continueDisabled}
                title={continueBlocked ? '当前 Agent 不支持会话恢复' : (!controllerOnline ? '控制器离线' : undefined)}
              >
                <Play className="size-4" />
                {resuming ? '继续中...' : '继续'}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="overflow-delete"
              onClick={onDelete}
              disabled={deleting}
              className="text-destructive"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              {deleting ? '删除中...' : '删除'}
            </DropdownMenuItem>
          </DropdownMenuPopup>
        </DropdownMenu>
      ) : (
        <div ref={toolbarRef} className="flex shrink-0 items-center gap-2" data-testid="session-header-toolbar">
          <Button
            variant="ghost"
            size="icon"
            aria-label="能力清单"
            title="能力清单"
            onClick={() => setCapabilityOpen(true)}
          >
            <Info className="size-4" />
          </Button>
          {onSplitModeChange && splitMode && (
            <div className="flex items-center gap-1" data-testid="split-mode-buttons">
              <Button
                variant={splitMode === 'chat' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => onSplitModeChange('chat')}
                title="仅会话"
                data-testid="split-mode-chat"
              >
                <MessageSquare className="h-4 w-4" />
              </Button>
              {wideEnoughForHorizontal !== false && (
                <Button
                  variant={splitMode === 'horizontal' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => onSplitModeChange('horizontal')}
                  title="左右分栏"
                  data-testid="split-mode-horizontal"
                >
                  <Columns2 className="h-4 w-4" />
                </Button>
              )}
              <Button
                variant={splitMode === 'vertical' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => onSplitModeChange('vertical')}
                title="上下分栏"
                data-testid="split-mode-vertical"
              >
                <Rows2 className="h-4 w-4" />
              </Button>
              {splitMode !== 'chat' && onLiveChange && (
                <Button
                  variant={live ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => onLiveChange(!live)}
                  title="实况跟随"
                  data-testid="live-toggle"
                >
                  <Activity className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}
          {onExport && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="导出对话"
              title="导出对话"
              onClick={onExport}
            >
              <Download className="size-4" />
            </Button>
          )}
          {onArchiveToggle && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={session?.archived ? '取消归档' : '归档'}
              title={session?.archived ? '取消归档' : '归档'}
              onClick={onArchiveToggle}
              disabled={archiving}
            >
              {archiving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : session?.archived ? (
                <ArchiveRestore className="size-4" />
              ) : (
                <Archive className="size-4" />
              )}
            </Button>
          )}
          {showClose && (
            <Button
              variant="destructive"
              onClick={onClose}
              disabled={closing}
            >
              {closing ? (
                <span className="flex items-center gap-1">
                  <Loader2 className="size-4 animate-spin" />
                  关闭中...
                </span>
              ) : '关闭'}
            </Button>
          )}
          {showContinue && (
            <Button
              onClick={onContinue}
              disabled={continueDisabled}
              title={continueBlocked ? '当前 Agent 不支持会话恢复' : (!controllerOnline ? '控制器离线' : undefined)}
            >
              {resuming ? '继续中...' : '继续'}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={onDelete}
            disabled={deleting}
          >
            {deleting ? (
              <span className="flex items-center gap-1">
                <Loader2 className="size-4 animate-spin" />
                删除中...
              </span>
            ) : '删除'}
          </Button>
        </div>
      )}
      <AgentCapabilityPanel
        open={capabilityOpen}
        onOpenChange={setCapabilityOpen}
        session={capabilitySession ?? null}
      />
    </div>
  );
}
