import { useEffect, useState } from 'react';
import { useQuery } from '@apollo/client/react';
import { usePreviewStore } from '../../../stores/preview';
import { PreviewTabBar } from './PreviewTabBar';
import { CodePreview } from './CodePreview';
import { HtmlPreview } from './HtmlPreview';
import { MarkdownPreview } from './MarkdownPreview';
import { GET_SESSION_FILE_CONTENT, type SessionFileContentData, type SessionReviewData } from '../../../graphql/preview';
import type { AnnotationBatch } from '../../../lib/preview/types';

/**
 * 预览区容器（提案 §5.2 实现点 6）：标签栏 + 内容区，按 tab kind/扩展名分流渲染。
 * 文件内容经 `sessionFileContent` 懒加载（骨架屏）；Review tab 动态懒加载 ReviewPanel。
 */

export interface PreviewPaneProps {
  sessionId: string;
  /** 批注回传 → 提示词片段（由 SessionView 接 prompt-composer） */
  onAnnotation: (batch: AnnotationBatch) => void;
  /** Review 状态数据源（session_review_updated SSE + 轮询兜底由上层提供） */
  reviewStatuses?: Record<string, SessionReviewData['status']>;
  /** Review 面板（注入以避免环依赖；缺省动态加载） */
  renderReview?: (reviewId: string) => React.ReactNode;
}

function componentForPath(filePath: string): 'markdown' | 'html' | 'code' {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  return 'code';
}

export function PreviewPane({ sessionId, onAnnotation, reviewStatuses = {}, renderReview }: PreviewPaneProps) {
  const store = usePreviewStore(sessionId);
  const active = store.tabs.find((tab) => tab.id === store.activeTabId) ?? null;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col" data-testid="preview-pane">
      <PreviewTabBar
        tabs={store.tabs}
        activeTabId={store.activeTabId}
        reviewStatuses={reviewStatuses}
        onActivate={store.setActive}
        onClose={store.closeTab}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {store.tabs.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground" data-testid="preview-empty">
            暂无预览内容
          </div>
        )}
        {active && active.kind === 'file' && (
          <FileTabContent
            sessionId={sessionId}
            filePath={active.filePath}
            diff={active.diff}
            focusLine={active.focusLine}
            onAnnotation={onAnnotation}
          />
        )}
        {active && active.kind === 'review' && (
          <div className="h-full min-h-0" data-testid="preview-review-tab">
            {renderReview ? renderReview(active.reviewId) : <ReviewPanelLazy reviewId={active.reviewId} sessionId={sessionId} onAnnotation={onAnnotation} />}
          </div>
        )}
      </div>
    </div>
  );
}

function FileTabContent({
  sessionId,
  filePath,
  diff,
  focusLine,
  onAnnotation,
}: {
  sessionId: string;
  filePath: string;
  diff?: { oldText: string | null; newText: string };
  focusLine?: number;
  onAnnotation: (batch: AnnotationBatch) => void;
}) {
  // 文件内容懒加载（切文件时拉取；Apollo 缓存去重）
  const { data, loading } = useQuery<{ sessionFileContent: SessionFileContentData }>(GET_SESSION_FILE_CONTENT, {
    variables: { sessionId, path: filePath },
    fetchPolicy: 'cache-and-network',
    skip: Boolean(diff),
  });

  if (!diff && (loading || !data?.sessionFileContent)) {
    return <div className="animate-pulse p-4 text-sm text-muted-foreground" data-testid="preview-skeleton">加载中…</div>;
  }

  const kind = componentForPath(filePath);
  const content = diff?.newText ?? data!.sessionFileContent.content;
  const truncated = diff ? false : data!.sessionFileContent.truncated;

  if (kind === 'markdown') {
    return <MarkdownPreview source={content} filePath={filePath} onConfirm={onAnnotation} />;
  }
  if (kind === 'html') {
    return <HtmlPreview html={content} filePath={filePath} onConfirm={onAnnotation} />;
  }
  return (
    <CodePreview
      filePath={filePath}
      content={content}
      oldText={diff ? diff.oldText : undefined}
      focusLine={focusLine}
      truncated={truncated}
      onConfirm={onAnnotation}
    />
  );
}

type ReviewPanelComponent = React.ComponentType<{
  reviewId: string;
  sessionId: string;
  onAnnotation?: (batch: AnnotationBatch) => void;
}>;

/** Review 面板动态懒加载（monaco/Mermaid 同型 seam） */
function ReviewPanelLazy(props: { reviewId: string; sessionId: string; onAnnotation: (batch: AnnotationBatch) => void }) {
  const [Component, setComponent] = useState<ReviewPanelComponent | null>(null);
  useEffect(() => {
    let disposed = false;
    void import('./ReviewPanel').then((module: { ReviewPanel: ReviewPanelComponent }) => {
      if (!disposed) setComponent(() => module.ReviewPanel);
    });
    return () => {
      disposed = true;
    };
  }, []);
  if (!Component) {
    return <div className="animate-pulse p-4 text-sm text-muted-foreground" data-testid="review-skeleton">加载中…</div>;
  }
  return <Component {...props} />;
}
