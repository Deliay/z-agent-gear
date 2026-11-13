import { Button } from '../ui/button';
import { useHomeOverview } from '../../stores/homeOverview';
import type { TodoItemData } from '../../graphql/types';

interface PendingElicitationBannerProps {
  sessionId: string;
}

/** 按 interactionId 定位会话时间线卡片（锚点由 `InteractionCard` 的 data-interaction-id 提供） */
function scrollToInteraction(interactionId: string): boolean {
  const escaped = interactionId.replace(/"/g, '\\"');
  const element = document.querySelector(`[data-interaction-id="${escaped}"]`);
  if (!element) return false;
  element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  return true;
}

/**
 * 会话内「待处理问询」提示条。
 *
 * 全局 TodoListPanel 只在桌面端侧边栏挂载；移动端会话详情下 Sidebar 不存在，
 * 该提示条保证会话内（含移动端）也能直达待处理问询。
 *
 * 点击行为已从「打开弹窗」改为「滚动定位到会话时间线中的对应卡片」（PRD 功能点 5）：
 * 表单只在卡片中存在，避免「弹窗填表」与「会话内容」两套形态。
 */
export function PendingElicitationBanner({ sessionId }: PendingElicitationBannerProps) {
  const { data } = useHomeOverview();

  const todos: TodoItemData[] = data?.todos ?? [];
  const pending = todos.filter(
    (todo) =>
      todo.type === 'elicitation_request'
      && todo.elicitationData?.sessionId === sessionId
      && !todo.resolution,
  );

  if (pending.length === 0) return null;

  return (
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
          const interactionId = first?.elicitationData?.requestId;
          if (interactionId) scrollToInteraction(interactionId);
        }}
      >
        查看
      </Button>
    </div>
  );
}
