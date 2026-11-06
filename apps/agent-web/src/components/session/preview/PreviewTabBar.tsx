import type { PreviewTab } from '../../../stores/preview';
import type { SessionReviewData } from '../../../graphql/preview';

/**
 * 预览区标签栏（提案 §5.2 实现点 6）：常开（pinned）/ 共享预览（预览语义）/
 * Review 标签；Review 图标四态色（PENDING 黄 / APPROVED 绿 / REJECTED 红 /
 * COMMENTED·CANCELLED 灰）。
 */

export const REVIEW_STATUS_CLASSES: Record<SessionReviewData['status'], string> = {
  PENDING: 'text-yellow-500',
  APPROVED: 'text-green-500',
  REJECTED: 'text-red-500',
  COMMENTED: 'text-muted-foreground',
  CANCELLED: 'text-muted-foreground italic',
};

export interface PreviewTabBarProps {
  tabs: PreviewTab[];
  activeTabId: string | null;
  reviewStatuses: Record<string, SessionReviewData['status']>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

function tabLabel(tab: PreviewTab): string {
  if (tab.kind === 'review') return `Review ${tab.reviewId.slice(-6)}`;
  const name = tab.filePath.split('/').pop() ?? tab.filePath;
  return name;
}

export function PreviewTabBar({ tabs, activeTabId, reviewStatuses, onActivate, onClose }: PreviewTabBarProps) {
  if (tabs.length === 0) return null;
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-1 py-1" data-testid="preview-tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`flex shrink-0 items-center gap-1 rounded-sm px-2 py-1 text-xs ${tab.id === activeTabId ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'}`}
          data-testid="preview-tab"
          data-active={tab.id === activeTabId}
          data-tab-kind={tab.kind}
        >
          <button type="button" className="min-w-0 truncate" onClick={() => onActivate(tab.id)}>
            {tab.kind === 'review' && (
              <span
                className={`mr-1 ${REVIEW_STATUS_CLASSES[reviewStatuses[tab.reviewId] ?? 'PENDING']}`}
                data-testid="review-tab-status"
                data-review-status={reviewStatuses[tab.reviewId] ?? 'PENDING'}
              >
                ●
              </span>
            )}
            {tabLabel(tab)}
            {tab.kind === 'file' && tab.pinned && <span className="ml-1 text-[10px] text-muted-foreground">常开</span>}
            {tab.kind === 'file' && !tab.pinned && <span className="ml-1 text-[10px] text-muted-foreground">预览</span>}
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onClose(tab.id)}
            data-testid="preview-tab-close"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
