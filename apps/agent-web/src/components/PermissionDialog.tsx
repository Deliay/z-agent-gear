import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import type { TodoItemData } from '../graphql/types';

interface PermissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  todo: TodoItemData;
}

/**
 * 权限审批通知弹窗（PRD 功能点 5）：不再承载审批按钮，只做「摘要 + 跳转到对应会话卡片」。
 *
 * 审批动作在会话时间线 `InteractionCard` 中完成（与提问卡片同源），弹窗仅作为通知入口。
 */
export function PermissionDialog({ open, onOpenChange, todo }: PermissionDialogProps) {
  const navigate = useNavigate();
  const requestId = todo.data?.requestId;
  const sessionId = todo.data?.sessionId;
  const toolCallTitle = todo.data?.toolCall?.title;

  const handleNavigate = () => {
    if (!sessionId) return;
    const anchor = requestId ? `#interaction-${encodeURIComponent(requestId)}` : '';
    onOpenChange(false);
    navigate(`/sessions/${sessionId}${anchor}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{todo.title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4" data-testid="permission-notice">
          <p className="text-sm text-muted-foreground">
            {todo.description || toolCallTitle || 'Agent 请求执行操作，需要你的确认。'}
          </p>

          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            该请求将在约 1 分钟后过期；请在会话内的权限审批卡片中选择。
          </p>

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              稍后处理
            </Button>
            <Button onClick={handleNavigate} disabled={!sessionId}>
              前往会话处理
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
