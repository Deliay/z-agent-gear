import { useState } from 'react';
import { STATUS_LABELS, getStatusDotColor } from './status-colors';
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
import { GitFork, GitBranch, Folder, Info, Loader2, Download, Archive, ArchiveRestore, MessageSquare, Columns2, Rows2, Activity, MoreHorizontalIcon, Play, Trash2, X } from 'lucide-react';
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
  /** 会话标题（契约 Session.title；缺失时回退控制器名/「会话」） */
  title?: string | null;
  acpServerType: string;
  status: string;
  externalSessionId: string | null;
  cwd: string | null;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
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

/** 工作区展示名：会话契约无工作区名称字段，以工作目录末段作为工作区标识（完整路径见环境胶囊） */
function workspaceLabelOf(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const normalized = cwd.replace(/\/+$/, '');
  if (!normalized) return cwd;
  const segments = normalized.split('/');
  return segments[segments.length - 1] || normalized;
}

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
  /** 所属工作区名称（契约未下发时以工作目录末段兜底） */
  workspaceName?: string | null;
}

export default function SessionHeader({ session, status, onClose, onDelete, onContinue, resuming, closing, deleting, controllerOnline, capabilities, capabilitySession, readOnly, onExport, onArchiveToggle, archiving, splitMode, onSplitModeChange, live, onLiveChange, wideEnoughForHorizontal, workspaceName }: SessionHeaderProps) {
  const isMobile = useIsMobile();
  const [capabilityOpen, setCapabilityOpen] = useState(false);

  const continueBlocked = (capabilities?.isBlocked('session.resume') ?? false)
    && (capabilities?.isBlocked('session.load') ?? false);
  const continueDisabled = resuming || !controllerOnline || continueBlocked;

  const showSplitOptions = Boolean(onSplitModeChange && splitMode);
  const showClose = status !== 'ended' && status !== 'creating' && status !== 'disconnected' && !resuming;
  const showContinue = (status === 'ended' || status === 'disconnected' || resuming) && !readOnly;
  const statusLabel = STATUS_LABELS[status] ?? status;
  const workspaceLabel = workspaceName ?? workspaceLabelOf(session?.cwd);
  const branchLabel = session?.worktreeBranch ?? null;

  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-4" data-testid="session-header">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {isMobile && <MobileBackButton to="/sessions" />}
        <h1 className="min-w-0 shrink truncate text-base font-semibold" data-testid="session-title">
          {session?.title || session?.controllerName || '会话'}
        </h1>
        {/* 状态圆点（规范 §2.4/§6-C）：sr-only 保留文案供读屏与既有 E2E 断言 */}
        <span
          data-testid="session-status-badge"
          role="status"
          title={statusLabel}
          aria-label={statusLabel}
          className="inline-flex shrink-0 items-center"
        >
          <span
            data-testid="session-status-dot"
            aria-hidden="true"
            className={`size-2 rounded-full ${getStatusDotColor(status)}`}
          />
          <span className="sr-only">{statusLabel}</span>
        </span>
        {session?.archived && (
          <span data-testid="session-archived-badge" className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            已归档
          </span>
        )}
        {(workspaceLabel || branchLabel) && !isMobile && (
          <div className="flex min-w-0 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            {workspaceLabel && (
              <span
                data-testid="session-workspace"
                className="flex max-w-32 items-center gap-1 truncate"
                title={session?.cwd ?? workspaceLabel}
              >
                <Folder className="size-3 shrink-0" />
                <span className="truncate">{workspaceLabel}</span>
              </span>
            )}
            {branchLabel && (
              <span
                data-testid="session-branch"
                className="flex max-w-32 items-center gap-1 truncate rounded bg-muted px-1.5 py-0.5"
                title={branchLabel}
              >
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{branchLabel}</span>
              </span>
            )}
          </div>
        )}
        {(session?.controllerName || session?.acpServerType || session?.cwd || session?.worktreePath || session?.createdAt) && !isMobile && (
          <div
            data-testid="session-env-capsule"
            title="环境信息：控制器 / Harness / 工作目录 / Worktree / 创建时间"
            className="flex min-w-0 items-center gap-2 rounded-full bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground"
          >
            {session?.controllerName && (
              <span data-testid="session-env-controller" className="shrink-0 truncate">
                控制器：{session.controllerName}
              </span>
            )}
            {session?.acpServerType && (
              <span className="shrink-0 rounded bg-background/60 px-1.5 py-0.5">
                {harnessLabel(session.acpServerType)}
              </span>
            )}
            {session?.cwd && (
              <span className="min-w-0 truncate font-mono" title={session.cwd}>
                {truncatePathLeft(session.cwd)}
              </span>
            )}
            {session?.worktreePath && (
              <span className="flex shrink-0 items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                <GitFork className="size-2.5" />
                Worktree
              </span>
            )}
            {session?.createdAt && (
              <span className="hidden shrink-0 tabular-nums lg:inline">
                {new Date(session.createdAt).toLocaleString()}
              </span>
            )}
          </div>
        )}
      </div>
      {/* 窄屏操作收纳：保留 session-header-overflow 锚点，行为改为断点驱动（G3，不再被动测量折叠） */}
      <div className="flex shrink-0 items-center md:hidden">
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
                className="text-destructive-text"
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
              className="text-destructive-text"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              {deleting ? '删除中...' : '删除'}
            </DropdownMenuItem>
          </DropdownMenuPopup>
        </DropdownMenu>
      </div>
      {/* 桌面端完整工具栏（≥md 常驻） */}
      <div className="hidden shrink-0 items-center gap-2 md:flex" data-testid="session-header-toolbar">
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
      <AgentCapabilityPanel
        open={capabilityOpen}
        onOpenChange={setCapabilityOpen}
        session={capabilitySession ?? null}
      />
    </div>
  );
}
