import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation } from '@apollo/client/react';
import { LIST_HISTORY_SESSIONS } from '../../graphql/queries';
import { IMPORT_HISTORY_SESSIONS } from '../../graphql/mutations';
import { logger } from '@/lib/logger';
import type { ListHistorySessionsQuery, HistorySessionInfoData, ImportSessionResultData, ImportHistorySessionsMutation } from '../../graphql/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

interface HistorySessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controllerId: string;
  workspaceId: string;
  workspaceName: string;
  availableAcpServers?: Array<{ type: string; version?: string }>;
}

const acpServerTypeLabels: Record<string, string> = {
  opencode: 'OpenCode',
  github_copilot: 'GitHub Copilot',
  claude_code: 'Claude Code',
  gemini_cli: 'Gemini CLI',
  codex: 'Codex',
};

export default function HistorySessionDialog({
  open,
  onOpenChange,
  controllerId,
  workspaceId,
  workspaceName,
  availableAcpServers,
}: HistorySessionDialogProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ total: number; completed: number } | null>(null);
  const [results, setResults] = useState<ImportSessionResultData[]>([]);
  const [acpServerType, setAcpServerType] = useState('opencode');

  const { data, loading, error, refetch } = useQuery<ListHistorySessionsQuery>(LIST_HISTORY_SESSIONS, {
    variables: { controllerId, workspaceId, acpServerType },
    skip: !open || !workspaceId,
    fetchPolicy: 'network-only',
  });

  const [importHistorySessions] = useMutation<ImportHistorySessionsMutation>(IMPORT_HISTORY_SESSIONS);

  useEffect(() => {
    if (open) {
      setSelectedIds(new Set());
      setImporting(false);
      setProgress(null);
      setResults([]);
    }
  }, [open]);

  const sessions = data?.listHistorySessions ?? [];
  const visibleSessions = importing
    ? sessions.filter((s) => selectedIds.has(s.sessionId))
    : sessions;

  const handleToggle = useCallback((sessionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === sessions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sessions.map((s) => s.sessionId)));
    }
  }, [sessions, selectedIds]);

  const handleImport = async () => {
    if (selectedIds.size === 0) return;

    setImporting(true);
    setProgress({ total: selectedIds.size, completed: 0 });

    try {
      const result = await importHistorySessions({
        variables: {
          controllerId,
          workspaceId,
          acpServerType,
          sessionIds: Array.from(selectedIds),
        },
      });

      const importResults = result.data?.importHistorySessions ?? [];
      setResults(importResults);
      setProgress({
        total: selectedIds.size,
        completed: importResults.filter((r) => r.success).length,
      });

      const failedIds = importResults.filter((r) => !r.success).map((r) => r.acpSessionId);
      setSelectedIds(new Set(failedIds));

      await refetch();
    } catch (err) {
      logger.error({ err }, 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  const getStatusText = () => {
    if (progress) {
      return `已导入 ${progress.completed}/${progress.total}`;
    }
    return null;
  };

  const hasSuccessResults = results.some((r) => r.success);
  const hasErrorResults = results.some((r) => !r.success);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>历史会话 - {workspaceName}</DialogTitle>
          <DialogDescription>
            选择要导入的历史会话，导入后可在会话列表中查看
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            加载中...
          </div>
        ) : error ? (
          <div className="py-8 text-center text-sm text-destructive">
            获取历史会话列表失败: {error.message}
          </div>
        ) : visibleSessions.length === 0 && results.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            该工作目录下没有未导入的历史会话
          </div>
        ) : (
          <>
            {availableAcpServers && availableAcpServers.length > 0 && (
              <div className="flex items-center gap-2 mb-2">
                <label className="text-sm text-muted-foreground">ACP Server:</label>
                <select
                  value={acpServerType}
                  onChange={(e) => setAcpServerType(e.target.value)}
                  className="rounded border px-2 py-1 text-sm"
                >
                  {availableAcpServers.map((s) => (
                    <option key={s.type} value={s.type}>
                      {acpServerTypeLabels[s.type] || s.type} {s.version ? `(${s.version})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {sessions.length} 个可导入的会话
              </span>
              {!importing && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleSelectAll}
                >
                  {selectedIds.size === sessions.length ? '取消全选' : '全选'}
                </Button>
              )}
            </div>

            <ul className="max-h-80 space-y-2 overflow-y-auto">
              {visibleSessions.map((s: HistorySessionInfoData) => (
                <li
                  key={s.sessionId}
                  className="flex items-center gap-3 rounded-lg border p-3"
                >
                  <Checkbox
                    checked={selectedIds.has(s.sessionId)}
                    onCheckedChange={() => handleToggle(s.sessionId)}
                    disabled={importing}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">
                      {s.title || `会话 - ${s.sessionId.slice(0, 8)}`}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {s.updatedAt
                        ? new Date(s.updatedAt).toLocaleString()
                        : '时间未知'}
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            {results.length > 0 && (
              <div className="space-y-1 rounded-lg border p-3 text-sm">
                {hasSuccessResults && (
                  <div className="text-green-600">
                    成功导入 {results.filter((r) => r.success).length} 个会话
                  </div>
                )}
                {hasErrorResults && (
                  <div className="space-y-1">
                    {results
                      .filter((r) => !r.success)
                      .map((r) => (
                        <div key={r.acpSessionId} className="text-destructive">
                          {r.title || r.acpSessionId.slice(0, 8)}: {r.error}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}

            {getStatusText() && (
              <div className="text-center text-sm text-muted-foreground">
                {getStatusText()}
              </div>
            )}
          </>
        )}

        <DialogFooter>
          {sessions.length > 0 && (
            <Button
              onClick={handleImport}
              disabled={selectedIds.size === 0 || importing}
            >
              {importing ? '导入中...' : `导入已选 (${selectedIds.size})`}
            </Button>
          )}
          <Button variant="outline" onClick={handleClose}>
            {results.length > 0 ? '完成' : '关闭'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
