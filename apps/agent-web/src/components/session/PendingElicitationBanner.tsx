import { useEffect } from 'react';
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
 * - 已打开弹窗优先用列表最新数据，todo 被 TTL 删除/limit 挤出时退回打开时快照并标记 missing，
 *   展示「已失效」终态而不是卸载弹窗；
 * - 切会话/卸载时只关闭自己（owner=banner）持有的弹窗，避免他会话幻影弹窗。
 */
export function PendingElicitationBanner({ sessionId }: PendingElicitationBannerProps) {
  const { data, refetch } = useHomeOverview();
  const { todoId, owner, snapshot, open, close } = useElicitationDialogState();

  const todos: TodoItemData[] = data?.todos ?? [];
  const pending = todos.filter(
    (todo) =>
      todo.type === 'elicitation_request'
      && todo.elicitationData?.sessionId === sessionId
      && !todo.resolution,
  );

  const liveTodo = owner === 'banner' && todoId
    ? todos.find((todo) => todo.id === todoId) ?? null
    : null;
  const belongsToSession = snapshot?.elicitationData?.sessionId === sessionId;
  const active = liveTodo ?? (owner === 'banner' && belongsToSession ? snapshot : null);
  const stale = Boolean(active) && !liveTodo;

  // 切会话后快照不属于本会话：关闭 banner 持有的弹窗，避免幻影重开
  useEffect(() => {
    if (owner === 'banner' && todoId && snapshot && !belongsToSession) {
      close('banner');
    }
  }, [owner, todoId, snapshot, belongsToSession, close]);

  // 会话组件卸载（切路由）时清掉自己持有的状态，避免残留 id 阻塞后续入口
  useEffect(() => () => close('banner'), [close]);

  return (
    <>
      {pending.length > 0 && (
        <div
          data-testid="pending-elicitation-banner"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        >
          <span>Agent 正在等待你的输入（{pending.length}）</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const first = pending[0];
              if (first) open(first, 'banner');
            }}
          >
            查看
          </Button>
        </div>
      )}
      {active && (
        <ElicitationDialog
          open
          stale={stale}
          onOpenChange={(next) => {
            if (!next) close('banner');
          }}
          todo={active}
          onResponded={() => {
            close('banner');
            refetch();
          }}
        />
      )}
    </>
  );
}
