import { useMemo, useState, useCallback } from 'react';
import MarkdownContent from '../MarkdownContent';
import { mapSelectionToSource, buildLineOffsets } from '../../../lib/preview/markdown-sourcepos';
import { AnnotationPopup } from './AnnotationPopup';
import { AnnotationList } from './AnnotationList';
import type { AnnotationBatch, ReviewComment } from '../../../lib/preview/types';

/**
 * Markdown 预览 + 文本选择批注（提案 §5.2 实现点 3）。
 *
 * 批注模式注入 `data-sourcepos`（仅批注模式，预览零开销）；`onMouseUp` 取选区
 * anchor/focus 节点最近 `[data-sourcepos]` 并集换算源文 offset，切片原文
 * （含标记符号）；不可映射 toast「该选择无法映射到原文」。
 */
export interface MarkdownPreviewProps {
  source: string;
  readOnly?: boolean;
  filePath?: string;
  onConfirm: (batch: AnnotationBatch) => void;
  /** 注入测试用提示（默认 alert，测试可注入 spy） */
  onUnmappable?: () => void;
}

export function MarkdownPreview({ source, readOnly = false, filePath, onConfirm, onUnmappable }: MarkdownPreviewProps) {
  const [annotate, setAnnotate] = useState(false);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [pending, setPending] = useState<{ text: string; startOffset: number; endOffset: number } | null>(null);
  const [summary, setSummary] = useState('');
  const lineOffsets = useMemo(() => buildLineOffsets(source), [source]);

  const handleMouseUp = useCallback(() => {
    if (!annotate) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const anchorEl = (selection.anchorNode?.nodeType === 1
      ? selection.anchorNode
      : selection.anchorNode?.parentElement) as Element | null;
    const focusEl = (selection.focusNode?.nodeType === 1
      ? selection.focusNode
      : selection.focusNode?.parentElement) as Element | null;
    const anchorPos = anchorEl?.closest('[data-sourcepos]')?.getAttribute('data-sourcepos');
    const focusPos = focusEl?.closest('[data-sourcepos]')?.getAttribute('data-sourcepos');
    const offsets = mapSelectionToSource(anchorPos, focusPos, source, lineOffsets);
    if (!offsets) {
      (onUnmappable ?? (() => window.alert('该选择无法映射到原文')))();
      return;
    }
    setPending({
      text: source.slice(offsets.startOffset, offsets.endOffset),
      startOffset: offsets.startOffset,
      endOffset: offsets.endOffset,
    });
    selection.removeAllRanges();
  }, [annotate, lineOffsets, onUnmappable, source]);

  const addComment = useCallback((body: string) => {
    if (body === '' || !pending) return;
    setComments((prev) => [
      ...prev,
      {
        id: `md-${Date.now()}-${prev.length}`,
        anchor: { kind: 'markdown', text: pending.text, startOffset: pending.startOffset, endOffset: pending.endOffset },
        body,
        createdAt: new Date().toISOString(),
      },
    ]);
    setPending(null);
  }, [pending]);

  const confirm = useCallback(() => {
    onConfirm({
      target: { source: 'markdown', ...(filePath ? { filePath } : {}) },
      comments,
      ...(summary.trim() !== '' ? { summary: summary.trim() } : {}),
    });
  }, [comments, filePath, onConfirm, summary]);

  // 批注模式注入 data-sourcepos（MarkdownContent annotate 通道，预览模式零开销）
  return (
    <div className="flex min-w-0 flex-col" data-testid="markdown-preview">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1">
        {!readOnly && (
          <button
            type="button"
            className={`rounded-sm px-2 py-1 text-xs ${annotate ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            onClick={() => setAnnotate((value) => !value)}
            data-testid="md-annotate-toggle"
          >
            批注模式
          </button>
        )}
        {annotate && (
          <button
            type="button"
            className="rounded-sm bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
            onClick={confirm}
            disabled={comments.length === 0}
            data-testid="md-confirm"
          >
            确认回传
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1 overflow-auto p-2" onMouseUp={handleMouseUp} data-testid="md-content">
        <MarkdownContent content={source} annotate={annotate} />
      </div>
      {annotate && (
        <div className="relative border-t border-border p-2">
          {pending && (
            <AnnotationPopup
              anchorLabel={pending.text.length > 40 ? `${pending.text.slice(0, 40)}…` : pending.text}
              onConfirm={addComment}
              onCancel={() => setPending(null)}
            />
          )}
          <AnnotationList comments={comments} onRemove={(id) => setComments((prev) => prev.filter((c) => c.id !== id))} />
          <div className="mt-2">
            <input
              className="w-full rounded-sm border border-input bg-background px-2 py-1 text-xs"
              placeholder="总体意见（可选）"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              data-testid="md-summary"
            />
          </div>
        </div>
      )}
    </div>
  );
}
