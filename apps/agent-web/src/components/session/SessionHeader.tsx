import { getStatusBadgeClass, STATUS_LABELS } from './status-colors';
import { useIsMobile } from '../../hooks/useIsMobile';
import MobileBackButton from '../MobileBackButton';

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
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                  <path d="M21 3h-3a2 2 0 0 0-2 2v3" />
                  <path d="M21 15v3a2 2 0 0 1-2 2h-3" />
                  <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
                  <polyline points="7 9 12 4 17 9" />
                  <polyline points="7 15 12 20 17 15" />
                </svg>
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
          <button
            type="button"
            onClick={onClose}
            disabled={closing}
            className={`rounded-md px-3 py-1.5 text-sm text-destructive-foreground ${
              closing
                ? 'cursor-not-allowed bg-destructive/60'
                : 'bg-destructive hover:bg-destructive/90'
            }`}
          >
            {closing ? (
              <span className="flex items-center gap-1">
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Closing...
              </span>
            ) : 'Close'}
          </button>
        )}
        {(status === 'ended' || resuming) && (
          <button
            type="button"
            onClick={onContinue}
            disabled={continueDisabled}
            title={!controllerOnline ? 'Controller is offline' : undefined}
            className={`rounded-md px-3 py-1.5 text-sm text-primary-foreground ${
              continueDisabled
                ? 'cursor-not-allowed bg-muted'
                : 'bg-primary hover:bg-primary/90'
            }`}
          >
            {resuming ? 'Continuing...' : 'Continue'}
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className={`rounded-md border px-3 py-1.5 text-sm ${
            deleting
              ? 'cursor-not-allowed border-border bg-muted text-muted-foreground'
              : 'border-border text-foreground hover:bg-accent'
          }`}
        >
          {deleting ? (
            <span className="flex items-center gap-1">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Deleting...
            </span>
          ) : 'Delete'}
        </button>
      </div>
    </div>
  );
}
