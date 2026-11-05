import { useEffect, useMemo, useRef, useState } from 'react';
import { injectSelectionScript, generateToken } from '../../../lib/preview/html-inject';
import { AnnotationPopup } from './AnnotationPopup';
import { AnnotationList } from './AnnotationList';
import type { AnnotationBatch, ReviewComment } from '../../../lib/preview/types';

/**
 * HTML 沙箱预览 + 元素选择批注（提案 §5.2 实现点 2）。
 *
 * `iframe sandbox="allow-scripts"`（无 `allow-same-origin` → 不透明源）；
 * srcDoc 注入选择脚本（随机令牌），postMessage 回传经 `event.source` + token 双校验。
 * 多选/再点已选取消；「批注」对当前选择集生成批注（每元素一条）；「确认回传」
 * 输出 `AnnotationBatch{target:{source:'html'}}`。内容变更重建 iframe。
 */
export interface HtmlPreviewProps {
  html: string;
  readOnly?: boolean;
  filePath?: string;
  onConfirm: (batch: AnnotationBatch) => void;
}

interface SelectionEntry {
  selector: string;
  innerHtml: string;
}

const INNER_HTML_STORE_LIMIT = 4000;

export function HtmlPreview({ html, filePath, onConfirm }: HtmlPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [token, setToken] = useState(() => generateToken());
  const [annotate, setAnnotate] = useState(false);
  const [selection, setSelection] = useState<SelectionEntry[]>([]);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [popupOpen, setPopupOpen] = useState(false);
  const [summary, setSummary] = useState('');

  // 内容变更重建 iframe（新令牌，旧脚本消息一律失效）
  const srcDoc = useMemo(() => injectSelectionScript(html, { annotate, token }), [html, annotate, token]);
  useEffect(() => {
    setToken(generateToken());
    setSelection([]);
  }, [html]);

  useEffect(() => {
    if (!annotate) return;
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { zagPreview?: boolean; token?: string; type?: string; payload?: SelectionEntry & { truncated?: boolean; selected?: boolean } };
      if (!data?.zagPreview || data.token !== token || data.type !== 'select' || !data.payload) return;
      const entry: SelectionEntry = {
        selector: data.payload.selector,
        innerHtml: (data.payload.innerHtml ?? '').slice(0, INNER_HTML_STORE_LIMIT),
      };
      setSelection((prev) => {
        const exists = prev.find((item) => item.selector === entry.selector);
        // 再次点击已选元素 = 取消（脚本按 toggle 回传 selected 标志）
        if (exists && data.payload?.selected === false) {
          return prev.filter((item) => item.selector !== entry.selector);
        }
        if (exists) return prev.map((item) => (item.selector === entry.selector ? entry : item));
        return [...prev, entry];
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [annotate, token]);

  const addComment = (body: string): void => {
    if (body === '') return;
    const now = new Date().toISOString();
    const created = selection.map((entry, index) => ({
      id: `html-${Date.now()}-${index}`,
      anchor: { kind: 'html' as const, selector: entry.selector, innerHtml: entry.innerHtml },
      body,
      createdAt: now,
    }));
    setComments((prev) => [...prev, ...created]);
    setSelection([]);
    setPopupOpen(false);
  };

  const confirm = (): void => {
    onConfirm({
      target: { source: 'html', ...(filePath ? { filePath } : {}) },
      comments,
      ...(summary.trim() !== '' ? { summary: summary.trim() } : {}),
    });
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="html-preview">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1">
        <button
          type="button"
          className={`rounded-sm px-2 py-1 text-xs ${annotate ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          onClick={() => setAnnotate((value) => !value)}
          data-testid="html-annotate-toggle"
        >
          批注模式
        </button>
        {annotate && selection.length > 0 && (
          <button
            type="button"
            className="rounded-sm bg-primary px-2 py-1 text-xs text-primary-foreground"
            onClick={() => setPopupOpen(true)}
            data-testid="html-annotate-selected"
          >
            批注（已选 {selection.length}）
          </button>
        )}
        {annotate && (
          <button
            type="button"
            className="rounded-sm bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
            onClick={confirm}
            disabled={comments.length === 0}
            data-testid="html-confirm"
          >
            确认回传
          </button>
        )}
      </div>
      <iframe
        ref={iframeRef}
        key={srcDoc.length + ':' + token}
        title="html-preview"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className="min-h-64 w-full flex-1 border-0"
        data-testid="html-preview-frame"
      />
      {annotate && (
        <div className="relative border-t border-border p-2">
          {popupOpen && (
            <AnnotationPopup
              anchorLabel={`已选 ${selection.length} 个元素`}
              onConfirm={addComment}
              onCancel={() => setPopupOpen(false)}
            />
          )}
          <AnnotationList comments={comments} onRemove={(id) => setComments((prev) => prev.filter((c) => c.id !== id))} />
          <div className="mt-2">
            <input
              className="w-full rounded-sm border border-input bg-background px-2 py-1 text-xs"
              placeholder="总体意见（可选）"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              data-testid="html-summary"
            />
          </div>
        </div>
      )}
    </div>
  );
}
