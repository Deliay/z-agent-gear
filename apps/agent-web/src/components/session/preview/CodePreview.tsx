import { useEffect, useRef, useState, useCallback } from 'react';
import { loadMonaco, type MonacoModule } from '../../../lib/preview/monaco-loader';
import { languageFromPath } from '../../../lib/language-from-path';
import { AnnotationPopup } from './AnnotationPopup';
import { AnnotationList } from './AnnotationList';
import type { AnnotationBatch, ReviewComment } from '../../../lib/preview/types';

/**
 * 代码组件（提案 §5.2 实现点 1）：Monaco editor core（裁决 7，动态 import 懒加载）。
 *
 * 能力：行定位（revealLineInCenter + 高亮装饰 3s 淡出保留常驻标记）、差异展示
 * （DiffEditor，oldText=null 按新建仅 modified，首差异块聚焦）、批注模式
 * （点击选行 / Shift 连选、React overlay 批注编辑器、批注列表、总体意见、
 * 「确认回传」输出 `AnnotationBatch{target:{source:'code',filePath}}`）、
 * readOnly、truncated 顶部提示条、model 按 filePath 复用保留 viewState。
 */

/** Prism 语言名 → monaco 语言 id 的少量差异映射 */
function monacoLanguage(filePath: string): string {
  const lang = languageFromPath(filePath);
  if (lang === 'markup') return 'html';
  if (lang === 'tsx' || lang === 'jsx') return 'typescript';
  return lang;
}

interface LineRange {
  startLine: number;
  endLine: number;
}

export interface CodePreviewProps {
  filePath: string;
  content: string;
  /** 传入字符串进入差异模式；null = 新建文件（仅 modified）；缺省 = 普通查看 */
  oldText?: string | null;
  focusLine?: number;
  truncated?: boolean;
  readOnly?: boolean;
  onConfirm?: (batch: AnnotationBatch) => void;
}

// model / viewState 按 filePath 复用（切 tab 保留滚动与光标位置）。
// model 以 uri 为键 getOrCreate（B2 返工：内容更新不再隐式建 model 导致泄漏）。
const viewStates = new Map<string, unknown>();
const modelCache = new Map<string, unknown>();

function getOrCreateModel(
  monaco: MonacoModule,
  filePath: string,
  content: string,
  language: string,
): { setValue: (value: string) => void } {
  // filePath 可能是绝对路径（真实 ACP 工具调用的 locations.path）或相对路径；
  // 绝对路径直接拼 `file:///` 会得到 `file:////...`，Monaco Uri.parse 抛
  // 「path cannot begin with two slash characters」。统一压成一个前导斜杠。
  const uri = monaco.Uri.parse(`file:///${filePath.replace(/^\/+/, '')}`);
  let model = modelCache.get(filePath) as { setValue: (value: string) => void } | undefined;
  if (!model) {
    const existing = monaco.editor.getModel(uri) as { setValue: (value: string) => void } | null;
    model = existing ?? (monaco.editor.createModel(content, language, uri) as unknown as { setValue: (value: string) => void });
    modelCache.set(filePath, model);
  } else {
    model.setValue(content);
  }
  return model;
}

/** 测试辅助：清空 model 缓存 */
export function resetCodePreviewModels(): void {
  modelCache.clear();
  viewStates.clear();
}

type MouseDownHost = {
  onMouseDown?: (fn: (e: { target: { position?: { lineNumber: number } }; event: { shiftKey: boolean } }) => void) => void;
};

export function CodePreview({
  filePath,
  content,
  oldText,
  focusLine,
  truncated = false,
  readOnly = false,
  onConfirm,
}: CodePreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<{ dispose: () => void; revealLineInCenter?: (line: number) => void; getLineChanges?: () => Array<{ modifiedStartLineNumber: number }> } | null>(null);
  const [annotate, setAnnotate] = useState(false);
  const [range, setRange] = useState<LineRange | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [summary, setSummary] = useState('');
  const anchorLineRef = useRef<number | null>(null);

  const isDiff = oldText !== undefined && oldText !== null;

  // 编辑器（或 diff 编辑器）创建/销毁
  useEffect(() => {
    let disposed = false;
    let savedState: unknown = viewStates.get(filePath);
    let editor: { saveViewState?: () => unknown; restoreViewState?: (state: unknown) => void; dispose: () => void; updateOptions?: (o: unknown) => void; revealLineInCenter?: (line: number) => void; onMouseDown?: (fn: (e: { target: { position?: { lineNumber: number } }; event: { shiftKey: boolean } }) => void) => void; deltaDecorations?: (old: string[], next: Array<Record<string, unknown>>) => string[]; getModel?: () => unknown } | null = null;
    let monacoRef: MonacoModule | null = null;

    // A5：行选（点击/Shift 连选）对普通编辑器与 diff 的 modified 编辑器同源绑定
    const bindLineSelection = (ed: MouseDownHost): void => {
      if (!annotate || !ed.onMouseDown) return;
      ed.onMouseDown((event) => {
        const line = event.target.position?.lineNumber;
        if (!line) return;
        if (event.event.shiftKey && anchorLineRef.current) {
          setRange({
            startLine: Math.min(anchorLineRef.current, line),
            endLine: Math.max(anchorLineRef.current, line),
          });
        } else {
          anchorLineRef.current = line;
          setRange({ startLine: line, endLine: line });
          setPopupOpen(true);
        }
      });
    };

    void loadMonaco().then((monaco) => {
      if (disposed || !containerRef.current) return;
      monacoRef = monaco;
      const language = monacoLanguage(filePath);
      const theme = document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs';
      if (isDiff) {
        const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
          readOnly: true,
          renderSideBySide: true,
          theme,
          automaticLayout: true,
        });
        const original = monaco.editor.createModel(oldText ?? '', language);
        const modified = monaco.editor.createModel(content, language);
        diffEditor.setModel({ original, modified });
        editor = diffEditor.getModifiedEditor() as unknown as typeof editor;
        // 首个差异块聚焦
        const changes = diffEditor.getLineChanges?.() ?? [];
        if (changes.length > 0) {
          diffEditor.getModifiedEditor().revealLineInCenter(changes[0].modifiedStartLineNumber);
        }
        // A5：diff 模式批注——行选绑定到 modified 编辑器（PRD 主场景：行内审查改动）
        bindLineSelection(diffEditor.getModifiedEditor() as unknown as MouseDownHost);
        editorRef.current = {
          dispose: () => {
            original.dispose();
            modified.dispose();
            diffEditor.dispose();
          },
          revealLineInCenter: (line: number) => diffEditor.getModifiedEditor().revealLineInCenter(line),
          getLineChanges: () => (diffEditor.getLineChanges?.() ?? []) as Array<{ modifiedStartLineNumber: number }>,
        };
        return;
      }
      const model = getOrCreateModel(monaco, filePath, content, language);
      const created = monaco.editor.create(containerRef.current, {
        model: model as never,
        language,
        readOnly,
        theme,
        automaticLayout: true,
        wordBasedSuggestions: 'currentDocument',
        minimap: { enabled: false },
      });
      editor = created as unknown as typeof editor;
      if (savedState && created.restoreViewState) {
        created.restoreViewState(savedState as never);
      }
      // A5：行选绑定（与 diff 的 modified 编辑器同源逻辑）
      bindLineSelection(created as unknown as MouseDownHost);
      editorRef.current = {
        dispose: () => {
          if (created.saveViewState) viewStates.set(filePath, created.saveViewState());
          created.dispose();
        },
        revealLineInCenter: (line: number) => created.revealLineInCenter(line),
      };
      if (focusLine && created.revealLineInCenter) {
        created.revealLineInCenter(focusLine);
        if (created.deltaDecorations) {
          // 高亮装饰 3s 淡出，保留常驻标记
          const highlight = created.deltaDecorations([], [{
            range: new monacoRef!.Range(focusLine, 1, focusLine, 1),
            options: { isWholeLine: true, className: 'zag-focus-highlight' },
          }]);
          setTimeout(() => {
            if (!disposed) {
              created.deltaDecorations?.(highlight, [{
                range: new monacoRef!.Range(focusLine, 1, focusLine, 1),
                options: { isWholeLine: true, className: 'zag-focus-marker' },
              }]);
            }
          }, 3000);
        }
      }
    });

    return () => {
      disposed = true;
      if (editor && editor.saveViewState) savedState = editor.saveViewState();
      if (savedState) viewStates.set(filePath, savedState);
      editorRef.current?.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, content, oldText, readOnly, annotate]);

  useEffect(() => {
    if (focusLine && editorRef.current?.revealLineInCenter) {
      editorRef.current.revealLineInCenter(focusLine);
    }
  }, [focusLine]);

  const addComment = useCallback((body: string) => {
    if (body === '' || !range) return;
    setComments((prev) => [
      ...prev,
      {
        id: `code-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${prev.length}`,
        anchor: { kind: 'code', filePath, startLine: range.startLine, endLine: range.endLine },
        body,
        createdAt: new Date().toISOString(),
      },
    ]);
    setRange(null);
    setPopupOpen(false);
  }, [filePath, range]);

  const confirm = useCallback(() => {
    onConfirm?.({
      target: { source: 'code', filePath },
      comments,
      ...(summary.trim() !== '' ? { summary: summary.trim() } : {}),
    });
    // A2：确认回传后清空批注状态（防止同一批注重复回传/跨文件残留）
    setComments([]);
    setSummary('');
    setRange(null);
  }, [comments, filePath, onConfirm, summary]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="code-preview">
      {truncated && (
        <div className="border-b border-yellow-500/40 bg-yellow-500/10 px-2 py-1 text-xs" data-testid="code-truncated">
          文件过大，内容已截断展示
        </div>
      )}
      <div className="flex items-center gap-2 border-b border-border px-2 py-1">
        {/* B2：批注入口与 readOnly 解耦（内容只读、批注恒可用） */}
        <button
          type="button"
          className={`rounded-sm px-2 py-1 text-xs ${annotate ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          onClick={() => { setAnnotate((value) => !value); setRange(null); setPopupOpen(false); }}
          data-testid="code-annotate-toggle"
        >
          批注模式
        </button>
        {annotate && (
          <button
            type="button"
            className="rounded-sm bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
            onClick={confirm}
            disabled={comments.length === 0}
            data-testid="code-confirm"
          >
            确认回传
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0 min-w-0" data-testid="code-editor-host" />
        {annotate && popupOpen && range && (
          <div className="absolute right-2 top-2 z-20">
            <AnnotationPopup
              anchorLabel={range.startLine === range.endLine ? `L${range.startLine}` : `L${range.startLine}-L${range.endLine}`}
              onConfirm={addComment}
              onCancel={() => { setPopupOpen(false); setRange(null); }}
            />
          </div>
        )}
      </div>
      {annotate && (
        <div className="border-t border-border p-2">
          <AnnotationList comments={comments} onRemove={(id) => setComments((prev) => prev.filter((c) => c.id !== id))} />
          <div className="mt-2">
            <input
              className="w-full rounded-sm border border-input bg-background px-2 py-1 text-xs"
              placeholder="总体意见（可选）"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              data-testid="code-summary"
            />
          </div>
        </div>
      )}
    </div>
  );
}
