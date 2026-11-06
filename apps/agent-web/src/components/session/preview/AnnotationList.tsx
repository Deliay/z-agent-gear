import type { ReviewComment } from '../../../lib/preview/types';

/**
 * 批注列表（提案 §5.2 实现点 4）：锚点摘要 + 删除单条。
 */
export interface AnnotationListProps {
  comments: ReviewComment[];
  onRemove: (id: string) => void;
}

function anchorLabel(comment: ReviewComment): string {
  const anchor = comment.anchor;
  if (anchor.kind === 'code') {
    return anchor.startLine === anchor.endLine
      ? `L${anchor.startLine}`
      : `L${anchor.startLine}-L${anchor.endLine}`;
  }
  if (anchor.kind === 'html') {
    return anchor.selector;
  }
  return anchor.text.length > 40 ? `${anchor.text.slice(0, 40)}…` : anchor.text;
}

export function AnnotationList({ comments, onRemove }: AnnotationListProps) {
  if (comments.length === 0) {
    return <div className="text-xs text-muted-foreground">暂无批注</div>;
  }
  return (
    <ul className="space-y-1" data-testid="annotation-list">
      {comments.map((comment) => (
        <li
          key={comment.id}
          className="flex items-start justify-between gap-2 rounded-sm border border-border px-2 py-1 text-xs"
        >
          <div className="min-w-0">
            <span className="mr-1 rounded-sm bg-muted px-1 font-mono">{anchorLabel(comment)}</span>
            <span className="break-words">{comment.body}</span>
          </div>
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => onRemove(comment.id)}
            data-testid="annotation-remove"
          >
            删除
          </button>
        </li>
      ))}
    </ul>
  );
}
