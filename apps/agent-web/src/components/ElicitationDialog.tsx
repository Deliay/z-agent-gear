import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import type { TodoItemData } from '../graphql/types';

interface ElicitationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  todo: TodoItemData;
  /** 待办已从列表移除（TTL/limit 挤出）：按已失效终态展示 */
  stale?: boolean;
  onResponded?: () => void;
}

function firstLine(text: string | null | undefined): string {
  if (!text) return '';
  const line = text.split('\n').find((part) => part.trim().length > 0) ?? '';
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

/**
 * 通知弹窗（PRD 功能点 5）：不再承载表单，只做「摘要 + 跳转到对应会话卡片」。
 *
 * 打开入口（`TodoListPanel`）与 `stores/elicitationDialog` 互斥机制保持不变；
 * 表单与作答逻辑已迁到会话时间线 `InteractionCard`（共享 `elicitation-form`）。
 */
export function ElicitationDialog({ open, onOpenChange, todo, stale = false, onResponded }: ElicitationDialogProps) {
  const navigate = useNavigate();
  const data = todo.elicitationData;
  const isFinished = Boolean(todo.resolution) || stale;

  const handleNavigate = () => {
    if (!data?.sessionId) return;
    const anchor = data.requestId ? `#interaction-${encodeURIComponent(data.requestId)}` : '';
    onOpenChange(false);
    onResponded?.();
    navigate(`/sessions/${data.sessionId}${anchor}`);
  };

  const isStale = stale && !todo.resolution;
  const statusMessage = isStale
    ? '该问询已失效（已从待办移除）'
    : todo.resolution === 'accepted'
      ? '该问询已提交'
      : todo.resolution === 'declined'
        ? '该问询已拒绝'
        : todo.resolution === 'cancelled'
          ? '该问询已取消'
          : todo.resolution === 'expired'
            ? '该问询已过期'
            : todo.resolution === 'failed'
              ? '该问询已失效'
              : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{todo.title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4" data-testid="elicitation-notice">
          <p className="text-sm text-muted-foreground">
            {firstLine(data?.message || todo.description) || 'Agent 正在等待你的输入。'}
          </p>

          {statusMessage && (
            <p
              data-testid="elicitation-status"
              role="status"
              aria-live="polite"
              className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
            >
              {statusMessage}
            </p>
          )}

          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {isFinished
              ? '该请求已结束，可在会话中查看处理结果。'
              : '该请求将在约 1 分钟后过期；请在会话内的提问卡片中填写并提交。'}
          </p>

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              稍后处理
            </Button>
            <Button onClick={handleNavigate} disabled={!data?.sessionId}>
              前往会话处理
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
