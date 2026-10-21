import { Button } from '../ui/button';
import { ElicitationDialog } from '../ElicitationDialog';
import { useHomeOverview } from '../../stores/homeOverview';
import { useElicitationDialogState } from '../../stores/elicitationDialog';
import type { TodoItemData } from '../../graphql/types';

interface PendingElicitationBannerProps {
  sessionId: string;
}

/**
 * 会话内「待处理问询」兜底入口。
 *
 * 全局 TodoListPanel 只在桌面端侧边栏挂载；移动端会话详情下 Sidebar 不存在，
 * Agent 的问询可能永远没有可见入口。该提示条保证会话内（含移动端）可打开弹窗。
 *
 * 入口显隐与弹窗生命周期解耦：
 * - 提示条只在存在未 resolved 问询时渲染；
 * - 已打开的弹窗按 todo id 从全量 todos 派生，即使 pending 变空也保留到出现终态，
 *   避免用户填表中因轮询（如超时标 expired）导致弹窗连同表单瞬间卸载。
 */
export function PendingElicitationBanner({ sessionId }: PendingElicitationBannerProps) {
  const { data, refetch } = useHomeOverview();
  const { todoId, owner, open, close } = useElicitationDialogState();

  const todos: TodoItemData[] = data?.todos ?? [];
  const pending = todos.filter(
    (todo) =>
      todo.type === 'elicitation_request'
      && todo.elicitationData?.sessionId === sessionId
      && !todo.resolution,
  );

  const active = owner === 'banner' && todoId
    ? todos.find((todo) => todo.id === todoId) ?? null
    : null;

  return (
    <>
      {pending.length > 0 && (
        <div
          data-testid="pending-elicitation-banner"
          aria-live="polite"
          className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        >
          <span>Agent 正在等待你的输入（{pending.length}）</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const first = pending[0];
              if (first) open(first.id, 'banner');
            }}
          >
            查看
          </Button>
        </div>
      )}
      {active && (
        <ElicitationDialog
          open
          onOpenChange={(next) => {
            if (!next) close();
          }}
          todo={active}
          onResponded={() => {
            close();
            refetch();
          }}
        />
      )}
    </>
  );
}
