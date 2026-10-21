import { useState } from 'react';
import { getStatusBadgeClass, STATUS_LABELS } from './status-colors';
import { useIsMobile } from '../../hooks/useIsMobile';
import MobileBackButton from '../MobileBackButton';
import { Button } from '../ui/button';
import { GitFork, Info, Loader2 } from 'lucide-react';
import { AgentCapabilityPanel } from './AgentCapabilityPanel';
import type { AgentCapabilitiesController } from '../../hooks/useAgentCapabilities';
import type { SessionData } from '../../graphql/types';

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
}

export default function SessionHeader({ session, status, onClose, onDelete, onContinue, resuming, closing, deleting, controllerOnline, capabilities, capabilitySession }: SessionHeaderProps) {
  const isMobile = useIsMobile();
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const acpServerTypeLabels: Record<string, string> = {
    opencode: 'OpenCode',
    github_copilot: 'GitHub Copilot',
    claude_code: 'Claude Code',
    gemini_cli: 'Gemini CLI',
    codex: 'Codex',
    mimo_code: 'MiMo Code',
    kimi_code: 'Kimi Code',
  };

  const continueBlocked = (capabilities?.isBlocked('session.resume') ?? false)
    && (capabilities?.isBlocked('session.load') ?? false);
  const continueDisabled = resuming || !controllerOnline || continueBlocked;

  return (
    <div className="flex items-center justify-between gap-2 border-b border-border bg-background px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
        {isMobile && <MobileBackButton to="/sessions" />}
        <h1 className="truncate text-lg font-semibold">
          {session?.controllerName || 'Session'}
        </h1>
        <span data-testid="session-status-badge" className={`rounded-full px-2 py-1 text-xs font-medium ${getStatusBadgeClass(status)}`}>
          {STATUS_LABELS[status] ?? status}
        </span>
        {session?.acpServerType && !isMobile && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {acpServerTypeLabels[session.acpServerType] || session.acpServerType}
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
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="能力清单"
          title="能力清单"
          onClick={() => setCapabilityOpen(true)}
        >
          <Info className="size-4" />
        </Button>
        {status !== 'ended' && status !== 'creating' && status !== 'disconnected' && !resuming && (
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
        {(status === 'ended' || status === 'disconnected' || resuming) && (
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
