import { useEffect, useState, type CSSProperties } from 'react';
import {
  renderTerminalOutput,
  type TerminalCellStyle,
  type TerminalLine,
} from '../../lib/terminal-buffer';
import { TERMINAL_THEME } from '../../lib/terminal-theme';

interface TerminalOutputProps {
  output: string;
  maxHeight?: string;
}

/** 流式输出合并窗口：同一批高频更新只触发最后一次解析 */
const PARSE_DEBOUNCE_MS = 60;

function spanStyle(style: TerminalCellStyle): CSSProperties {
  const decorations: string[] = [];
  if (style.underline) decorations.push('underline');
  if (style.strikethrough) decorations.push('line-through');
  if (style.overline) decorations.push('overline');

  return {
    color: style.fg,
    backgroundColor: style.bg,
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    textDecorationLine: decorations.length > 0 ? decorations.join(' ') : undefined,
    opacity: style.dim ? 0.6 : undefined,
  };
}

/**
 * 终端输出渲染：经 `@xterm/headless` 完整终端仿真收敛为最终画面后，
 * 以 React 文本节点逐行渲染（无 HTML 注入面），容器固定深黑主题。
 */
export default function TerminalOutput({ output, maxHeight = '24rem' }: TerminalOutputProps) {
  const [lines, setLines] = useState<TerminalLine[]>([]);

  useEffect(() => {
    if (!output) {
      setLines([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void renderTerminalOutput(output).then((next) => {
        // 丢弃过期解析结果；解析期间保留上一次结果，避免闪烁
        if (!cancelled) setLines(next);
      });
    }, PARSE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [output]);

  return (
    <div
      data-testid="terminal-output"
      data-terminal-theme="dark"
      aria-label="终端输出"
      className="min-h-6 min-w-0 overflow-auto rounded-lg p-3 font-mono text-sm leading-relaxed"
      style={{
        maxHeight,
        backgroundColor: TERMINAL_THEME.background,
        color: TERMINAL_THEME.foreground,
      }}
    >
      <div className="w-max min-w-full">
        {lines.map((line, lineIndex) => (
          <div key={lineIndex} data-testid="terminal-line" className="whitespace-pre">
            {line.spans.length === 0
              ? ' '
              : line.spans.map((span, spanIndex) => (
                  <span key={spanIndex} style={spanStyle(span.style)}>
                    {span.text}
                  </span>
                ))}
          </div>
        ))}
      </div>
    </div>
  );
}
