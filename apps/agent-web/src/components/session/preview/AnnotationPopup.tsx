import { useState, useRef, useEffect } from 'react';

/**
 * 批注输入弹层（提案 §5.2 实现点 4）：确认追加 / 取消。
 * 批注文本经 React 转义渲染（无 XSS 面）。
 */
export interface AnnotationPopupProps {
  /** 锚点摘要（展示于弹层顶部） */
  anchorLabel: string;
  onConfirm: (body: string) => void;
  onCancel: () => void;
}

export function AnnotationPopup({ anchorLabel, onConfirm, onCancel }: AnnotationPopupProps) {
  const [body, setBody] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className="absolute z-20 w-72 rounded-md border border-border bg-card p-3 shadow-lg"
      data-testid="annotation-popup"
    >
      <div className="mb-2 truncate text-xs text-muted-foreground">{anchorLabel}</div>
      <textarea
        ref={inputRef}
        className="min-h-16 w-full rounded-sm border border-input bg-background p-2 text-sm"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="输入批注内容"
        data-testid="annotation-input"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          onClick={onCancel}
          data-testid="annotation-cancel"
        >
          取消
        </button>
        <button
          type="button"
          className="rounded-sm bg-primary px-2 py-1 text-xs text-primary-foreground hover:opacity-90"
          onClick={() => onConfirm(body.trim())}
          disabled={body.trim() === ''}
          data-testid="annotation-confirm"
        >
          确认追加
        </button>
      </div>
    </div>
  );
}
