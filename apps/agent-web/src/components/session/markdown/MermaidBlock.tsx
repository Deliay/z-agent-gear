import { useEffect, useId, useMemo, useState } from 'react';
import { Code2, Minus, Plus, RotateCcw } from 'lucide-react';
import CodeBlock from './CodeBlock';

interface MermaidBlockProps {
  code: string;
}

type MermaidTheme = 'dark' | 'default';

function detectTheme(): MermaidTheme {
  if (typeof document === 'undefined') return 'default';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'default';
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

export default function MermaidBlock({ code }: MermaidBlockProps) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showSource, setShowSource] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [theme, setTheme] = useState<MermaidTheme>(() => detectTheme());
  const rawId = useId();
  const renderId = useMemo(() => `mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`, [rawId]);

  // 主题跟随：documentElement 的 dark class 变化时重渲染（key 含主题）
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => setTheme(detectTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setSvg('');

    (async () => {
      try {
        const mod = await import('mermaid');
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme,
        });
        const result = await mermaid.render(renderId, code);
        if (!cancelled) {
          setSvg(result.svg);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, theme, renderId]);

  if (error) {
    return <CodeBlock code={code} language="mermaid" />;
  }

  const adjustZoom = (delta: number) => {
    setZoom((prev) => {
      const next = Math.round((prev + delta) * 100) / 100;
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    });
  };

  return (
    <div
      className="group my-2 overflow-hidden rounded-md border border-border bg-background"
      data-testid="mermaid-block"
      data-theme={theme}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/60 px-2 py-1">
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">mermaid</span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="缩小"
            title="缩小"
            onClick={() => adjustZoom(-ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="重置缩放"
            title="重置缩放"
            onClick={() => setZoom(1)}
            className="rounded px-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid="mermaid-zoom-value"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="放大"
            title="放大"
            onClick={() => adjustZoom(ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <Plus className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={showSource ? '查看图形' : '查看源码'}
            title={showSource ? '查看图形' : '查看源码'}
            onClick={() => setShowSource((prev) => !prev)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {showSource ? <RotateCcw className="size-3.5" /> : <Code2 className="size-3.5" />}
          </button>
        </div>
      </div>

      {showSource ? (
        <pre className="m-0 overflow-x-auto p-3 font-mono text-xs whitespace-pre">{code}</pre>
      ) : loading ? (
        <div className="animate-pulse p-6" data-testid="mermaid-skeleton">
          <div className="mx-auto h-24 w-3/4 rounded bg-muted" />
        </div>
      ) : (
        <div className="overflow-auto p-3">
          <div
            className="origin-top-left [&_svg]:max-w-full"
            style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
            // mermaid securityLevel=strict 输出，无脚本
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
    </div>
  );
}
