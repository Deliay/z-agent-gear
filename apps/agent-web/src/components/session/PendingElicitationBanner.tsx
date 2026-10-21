import { useState } from 'react';
import { Button } from '../ui/button';
import { ElicitationDialog } from '../ElicitationDialog';
import { useHomeOverview } from '../../stores/homeOverview';
import type { TodoItemData } from '../../graphql/types';

interface PendingElicitationBannerProps {
  sessionId: string;
}

/**
 * 会话内「待处理问询」兜底入口。
 *
 * 全局 TodoListPanel 只在桌面端侧边栏挂载；移动端会话详情下 Sidebar 不存在，
 * Agent 的问询可能永远没有可见入口。该提示条保证会话内（含移动端）可打开弹窗。
 */
export function PendingElicitationBanner({ sessionId }: PendingElicitationBannerProps) {
  const { data, refetch } = useHomeOverview();
  const [open, setOpen] = useState(false);

  const todos: TodoItemData[] = data?.todos ?? [];
  const pending = todos.filter(
    (todo) =>
      todo.type === 'elicitation_request'
      && todo.elicitationData?.sessionId === sessionId
      && !todo.resolution,
  );

  if (pending.length === 0) return null;

  const active = pending[0];

  return (
    <>
      <div
        data-testid="pending-elicitation-banner"
        className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
      >
        <span>Agent 正在等待你的输入（{pending.length}）</span>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          查看
        </Button>
      </div>
      <ElicitationDialog
        open={open}
        onOpenChange={setOpen}
        todo={active}
        onResponded={() => {
          setOpen(false);
          refetch();
        }}
      />
    </>
  );
}
