import { ArrowDown } from 'lucide-react';

interface ScrollToBottomButtonProps {
  visible: boolean;
  hasNewMessages?: boolean;
  onClick: () => void;
}

/** 回到底部浮动按钮：不在底部时出现，暂停跟随期间有新消息显示圆点 */
export default function ScrollToBottomButton({ visible, hasNewMessages, onClick }: ScrollToBottomButtonProps) {
  if (!visible) return null;

  return (
    <button
      type="button"
      aria-label="回到底部"
      title="回到底部"
      onClick={onClick}
      data-testid="scroll-to-bottom"
      className="absolute bottom-4 right-4 z-10 flex size-9 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-md transition-colors hover:bg-muted"
    >
      <ArrowDown className="size-4" />
      {hasNewMessages && (
        <span
          data-testid="scroll-to-bottom-dot"
          className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-primary ring-2 ring-background"
        />
      )}
    </button>
  );
}
