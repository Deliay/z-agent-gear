import { useMemo, useState, useCallback } from 'react';
import { useQuery, useMutation } from '@apollo/client/react';
import { toast } from 'sonner';
import { CodePreview } from './CodePreview';
import { HtmlPreview } from './HtmlPreview';
import { MarkdownPreview } from './MarkdownPreview';
import { useSessionFileContent } from './useSessionFileContent';
import {
  GET_SESSION_REVIEW,
  SUBMIT_SESSION_REVIEW,
  type SessionReviewData,
  type SessionReviewCommentData,
} from '../../../graphql/preview';
import type { AnnotationBatch } from '../../../lib/preview/types';

/**
 * Review 标签页（提案 §5.2 实现点 11）：左侧按目录分组的文件树（当前文件高亮 +
 * 每文件批注计数徽标），右侧按扩展名分流内容组件（只读 + 批注模式），
 * 文件内容经 `sessionFileContent` 懒加载（骨架屏）；底部总体意见 +
 * 通过/驳回/仅评论三按钮提交；成功后只读化展示结论徽标，失败 toast 可重试。
 */

export interface ReviewPanelProps {
  reviewId: string;
  sessionId: string;
  onAnnotation?: (batch: AnnotationBatch) => void;
}

function componentKind(filePath: string): 'markdown' | 'html' | 'code' {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  return 'code';
}

/** 按目录分组（顶层目录 → 文件列表） */
function groupByDirectory(files: string[]): Array<{ dir: string; files: string[] }> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const index = file.lastIndexOf('/');
    const dir = index > 0 ? file.slice(0, index) : '.';
    const list = groups.get(dir) ?? [];
    list.push(file);
    groups.set(dir, list);
  }
  return [...groups.entries()].map(([dir, list]) => ({ dir, files: list }));
}

const STATUS_BADGES: Record<SessionReviewData['status'], { label: string; className: string }> = {
  PENDING: { label: '待评审', className: 'bg-yellow-500/15 text-yellow-600' },
  APPROVED: { label: '已通过', className: 'bg-green-500/15 text-green-600' },
  REJECTED: { label: '已驳回', className: 'bg-red-500/15 text-red-600' },
  COMMENTED: { label: '仅评论', className: 'bg-muted text-muted-foreground' },
  CANCELLED: { label: '已取消', className: 'bg-muted text-muted-foreground italic' },
};

export function ReviewPanel({ reviewId, sessionId }: ReviewPanelProps) {
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [fileReviews, setFileReviews] = useState<Record<string, SessionReviewCommentData[]>>({});
  const [summary, setSummary] = useState('');

  const { data, loading: reviewLoading } = useQuery<{ sessionReview: SessionReviewData | null }>(GET_SESSION_REVIEW, {
    variables: { id: reviewId },
    fetchPolicy: 'cache-and-network',
    pollInterval: 15_000,
  });
  const review = data?.sessionReview ?? null;

  const activeFile = currentFile ?? review?.files[0] ?? null;
  const {
    status: fileStatus,
    content: fileContent,
    truncated: fileTruncated,
    error: fileError,
    retry: retryFile,
  } = useSessionFileContent(sessionId, activeFile ?? '', !activeFile);

  const [submitReview, { loading: submitting }] = useMutation<{ submitSessionReview: SessionReviewData }>(
    SUBMIT_SESSION_REVIEW,
    {
      refetchQueries: [{ query: GET_SESSION_REVIEW, variables: { id: reviewId } }],
    },
  );

  const resolved = review ? review.status !== 'PENDING' : false;
  const groups = useMemo(() => groupByDirectory(review?.files ?? []), [review?.files]);

  const handleFileAnnotation = useCallback(
    (file: string) => (batch: AnnotationBatch) => {
      // A2：批注按文件聚合进 file_reviews（key 隔离 + 组件确认后清空，无跨文件串扰）。
      // A1（三轮返工）：组件确认后清空本地列表，本侧按 id 合并追加——
      // 同文件多轮/往返批注累积不丢失（文件树计数徽标随聚合增长）。
      // B5-1：Review 场景批注经 file_reviews 结构化回传 Agent，不回传输入区（PRD §3.3）。
      setFileReviews((prev) => {
        const existing = prev[file] ?? [];
        const seen = new Set(existing.map((comment) => comment.id));
        const additions = (batch.comments as unknown as SessionReviewCommentData[]).filter(
          (comment) => !seen.has(comment.id),
        );
        return { ...prev, [file]: [...existing, ...additions] };
      });
    },
    [],
  );

  const submit = useCallback(
    async (action: 'approve' | 'reject' | 'comment') => {
      try {
        await submitReview({
          variables: {
            id: reviewId,
            input: { fileReviews, comment: summary.trim() !== '' ? summary.trim() : null, status: action },
          },
        });
        toast.success('评审已提交');
      } catch (error) {
        toast.error(`评审提交失败：${(error as Error).message}，可重试`);
      }
    },
    [fileReviews, reviewId, submitReview, summary],
  );

  if (reviewLoading && !review) {
    return <div className="animate-pulse p-4 text-sm text-muted-foreground" data-testid="review-skeleton">加载中…</div>;
  }
  if (!review) {
    return <div className="p-4 text-sm text-muted-foreground" data-testid="review-not-found">Review 不存在或已删除</div>;
  }

  const badge = STATUS_BADGES[review.status] ?? STATUS_BADGES.PENDING;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="review-panel">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1">
        <span className={`rounded-sm px-2 py-0.5 text-xs ${badge.className}`} data-testid="review-status-badge">
          {badge.label}
        </span>
        {review.comment && <span className="truncate text-xs text-muted-foreground">{review.comment}</span>}
        {review.status === 'CANCELLED' && review.cancelReason && (
          <span className="text-xs text-muted-foreground">（{review.cancelReason}）</span>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        {/* 左侧文件树 */}
        <div className="w-48 shrink-0 overflow-auto border-r border-border p-2" data-testid="review-file-tree">
          {groups.map((group) => (
            <div key={group.dir} className="mb-2">
              <div className="truncate px-1 text-[10px] text-muted-foreground">{group.dir}</div>
              {group.files.map((file) => (
                <button
                  key={file}
                  type="button"
                  className={`flex w-full items-center justify-between truncate rounded-sm px-1 py-0.5 text-left text-xs ${file === activeFile ? 'bg-muted font-medium' : 'hover:bg-muted/50'}`}
                  onClick={() => setCurrentFile(file)}
                  data-testid="review-file-item"
                  data-active={file === activeFile}
                >
                  <span className="min-w-0 truncate">{file.split('/').pop()}</span>
                  {(fileReviews[file]?.length ?? 0) > 0 && (
                    <span className="ml-1 rounded-sm bg-muted px-1 text-[10px]" data-testid="review-file-count">
                      {fileReviews[file].length}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
        {/* 右侧内容组件 */}
        <div className="min-w-0 flex-1">
          {!activeFile && <div className="p-4 text-sm text-muted-foreground">无评审文件</div>}
          {activeFile && fileStatus === 'loading' && (
            <div className="animate-pulse p-4 text-sm text-muted-foreground" data-testid="review-file-skeleton">加载中…</div>
          )}
          {activeFile && fileStatus === 'error' && (
            <div className="flex flex-col gap-2 p-4 text-sm" data-testid="review-file-error">
              <div className="text-destructive">加载失败：{fileError?.message ?? '文件内容读取失败'}</div>
              <div className="text-xs text-muted-foreground">
                控制器可能离线、文件不可读，或 agent-gear 版本过低；若持续失败，请确认控制器上的 agent-gear 已升级到最新版本。
              </div>
              <button
                type="button"
                className="self-start rounded-sm border border-input px-2 py-1 text-xs hover:bg-muted"
                data-testid="review-file-retry"
                onClick={retryFile}
              >
                重试
              </button>
            </div>
          )}
          {/* B2：内容恒只读（含 PENDING），批注恒可用 */}
          {activeFile && fileStatus === 'ready' && (
            <ReviewFileContent
              key={activeFile}
              filePath={activeFile}
              content={fileContent}
              truncated={fileTruncated}
              readOnly
              onConfirm={handleFileAnnotation(activeFile)}
            />
          )}
        </div>
      </div>
      {/* 底部提交区 */}
      {!resolved ? (
        <div className="border-t border-border p-2">
          <textarea
            className="min-h-12 w-full rounded-sm border border-input bg-background p-2 text-xs"
            placeholder="总体评审意见"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            data-testid="review-summary"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-sm bg-green-600 px-3 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50"
              onClick={() => void submit('approve')}
              disabled={submitting}
              data-testid="review-approve"
            >
              通过
            </button>
            <button
              type="button"
              className="rounded-sm bg-red-600 px-3 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50"
              onClick={() => void submit('reject')}
              disabled={submitting}
              data-testid="review-reject"
            >
              驳回
            </button>
            <button
              type="button"
              className="rounded-sm bg-muted px-3 py-1 text-xs hover:opacity-90 disabled:opacity-50"
              onClick={() => void submit('comment')}
              disabled={submitting}
              data-testid="review-comment"
            >
              仅评论
            </button>
          </div>
        </div>
      ) : (
        <div className="border-t border-border p-2 text-xs text-muted-foreground" data-testid="review-resolved">
          评审已完成：{badge.label}
          {review.comment ? ` — ${review.comment}` : ''}
        </div>
      )}
    </div>
  );
}

function ReviewFileContent({
  filePath,
  content,
  truncated,
  readOnly,
  onConfirm,
}: {
  filePath: string;
  content: string;
  truncated: boolean;
  readOnly: boolean;
  onConfirm: (batch: AnnotationBatch) => void;
}) {
  const kind = componentKind(filePath);
  if (kind === 'markdown') {
    return <MarkdownPreview source={content} filePath={filePath} readOnly={readOnly} onConfirm={onConfirm} />;
  }
  if (kind === 'html') {
    return <HtmlPreview html={content} filePath={filePath} readOnly={readOnly} onConfirm={onConfirm} />;
  }
  return <CodePreview filePath={filePath} content={content} truncated={truncated} readOnly={readOnly} onConfirm={onConfirm} />;
}
