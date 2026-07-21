import { getStatusBadgeClass, STATUS_LABELS } from './status-colors';
import { useIsMobile } from '../../hooks/useIsMobile';
import MobileBackButton from '../MobileBackButton';
import { Button } from '../ui/button';
import { GitFork, Loader2 } from 'lucide-react';

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
}

export default function SessionHeader({ session, status, onClose, onDelete, onContinue, resuming, closing, deleting, controllerOnline }: SessionHeaderProps) {
  const isMobile = useIsMobile();
  const acpServerTypeLabels: Record<string, string> = {
    opencode: 'OpenCode',
    github_copilot: 'GitHub Copilot',
    claude_code: 'Claude Code',
    gemini_cli: 'Gemini CLI',
    codex: 'Codex',
    mimo_code: 'MiMo Code',
    kimi_code: 'Kimi Code',
  };

  const continueDisabled = resuming || !controllerOnline;

  return (
    <div className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
      <div className="flex items-center gap-4">
        {isMobile && <MobileBackButton to="/sessions" />}
        <h1 className="text-lg font-semibold">
          {session?.controllerName || 'Session'}
        </h1>
        <span className={`rounded-full px-2 py-1 text-xs font-medium ${getStatusBadgeClass(status)}`}>
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
      <div className="flex items-center gap-2">
        {status !== 'ended' && status !== 'creating' && !resuming && (
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
        {(status === 'ended' || resuming) && (
          <Button
            onClick={onContinue}
            disabled={continueDisabled}
            title={!controllerOnline ? '控制器离线' : undefined}
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
    </div>
  );
}
