import { useState } from 'react';
import { useQuery } from '@apollo/client/react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Eye } from 'lucide-react';
import { HOME_OVERVIEW } from '../../graphql/home';
import type { SessionReviewSummaryData } from '../../graphql/types';

/**
 * 侧边栏 Review 分区（提案 §5.2 实现点 11）：「待 Review」（PENDING，含会话 id 与
 * 文件数）默认展开、「已 Review」（终态）默认折叠；数据源 `HOME_OVERVIEW.sessionReviews`
 * （`session_review_*` 用户级 SSE 触发上层 refetch），点击深链
 * `/sessions/{sessionId}?review={id}`；空分区整体不渲染。
 */

interface ReviewSectionProps {
  /** 外部注入数据（MainLayout HOME_OVERVIEW 同源）；缺省自查缓存 */
  sessionReviews?: SessionReviewSummaryData[];
}

function ReviewRow({ review }: { review: SessionReviewSummaryData }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={() => navigate(`/sessions/${review.sessionId}?review=${review.id}`)}
      data-testid="review-section-item"
      data-review-status={review.status}
    >
      <Eye className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {review.sessionId.slice(-8)} · {review.files.length} 文件
      </span>
      <span
        className={`size-2 shrink-0 rounded-full ${
          review.status === 'PENDING'
            ? 'bg-yellow-500'
            : review.status === 'APPROVED'
              ? 'bg-green-500'
              : review.status === 'REJECTED'
                ? 'bg-red-500'
                : 'bg-muted-foreground/50'
        }`}
      />
    </button>
  );
}

export default function ReviewSection({ sessionReviews }: ReviewSectionProps) {
  const { data } = useQuery<{ homeOverview: { sessionReviews: SessionReviewSummaryData[] } }>(HOME_OVERVIEW, {
    fetchPolicy: 'cache-and-network',
    skip: sessionReviews !== undefined,
  });
  const reviews = sessionReviews ?? data?.homeOverview?.sessionReviews ?? [];
  const [pendingExpanded, setPendingExpanded] = useState(true);
  const [resolvedExpanded, setResolvedExpanded] = useState(false);

  const pending = reviews.filter((review) => review.status === 'PENDING');
  const resolved = reviews.filter((review) => review.status !== 'PENDING');
  if (reviews.length === 0) return null;

  return (
    <div className="mt-2" data-testid="review-section">
      <button
        type="button"
        className="flex w-full items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setPendingExpanded((value) => !value)}
        data-testid="review-section-pending-toggle"
      >
        {pendingExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        待 Review（{pending.length}）
      </button>
      {pendingExpanded && (
        <div className="space-y-0.5">
          {pending.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground/60">暂无待 Review</div>
          )}
          {pending.map((review) => (
            <ReviewRow key={review.id} review={review} />
          ))}
        </div>
      )}
      {resolved.length > 0 && (
        <>
          <button
            type="button"
            className="flex w-full items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setResolvedExpanded((value) => !value)}
            data-testid="review-section-resolved-toggle"
          >
            {resolvedExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            已 Review（{resolved.length}）
          </button>
          {resolvedExpanded && (
            <div className="space-y-0.5">
              {resolved.map((review) => (
                <ReviewRow key={review.id} review={review} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
