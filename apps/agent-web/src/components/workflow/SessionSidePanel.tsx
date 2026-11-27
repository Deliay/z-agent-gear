import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import SessionView from '@/components/session/SessionView';
import type { WorkflowNodeStatus } from '@/graphql/workflow';
import { NODE_STATUS_BADGE, NODE_STATUS_LABELS } from './WorkflowNodeTreeConstants';

interface SessionSidePanelProps {
  sessionId: string | null;
  nodeName?: string | null;
  nodeStatus?: WorkflowNodeStatus | null;
  onClose: () => void;
}

/** 节点会话侧面板：标准 Sheet 抽屉形态，顶栏展示所属节点名称/状态与独立页跳转入口 */
export default function SessionSidePanel({
  sessionId,
  nodeName,
  nodeStatus,
  onClose,
}: SessionSidePanelProps) {
  return (
    <Sheet open={sessionId != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        data-testid="session-side-panel"
        className="w-full gap-0 overflow-hidden p-0 sm:max-w-4xl"
      >
        <SheetHeader className="flex-row items-center justify-between gap-2 border-b border-border bg-card/60 px-4 py-3 pr-12">
          <div className="flex min-w-0 items-center gap-2">
            <SheetTitle className="truncate text-sm font-semibold">
              {nodeName ? `${nodeName} · 节点会话` : '节点会话'}
            </SheetTitle>
            {nodeStatus && (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${NODE_STATUS_BADGE[nodeStatus]}`}
              >
                {NODE_STATUS_LABELS[nodeStatus]}
              </span>
            )}
          </div>
          {sessionId && (
            <Link
              to={`/sessions/${sessionId}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ExternalLink className="size-3" />
              <span>独立页面打开</span>
            </Link>
          )}
        </SheetHeader>
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {sessionId && <SessionView key={sessionId} sessionId={sessionId} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}
