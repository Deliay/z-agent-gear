import { useMemo } from 'react';
import { ansiToHtml } from '../../lib/ansi';

interface TerminalOutputProps {
  output: string;
  maxHeight?: string;
}

/**
 * 终端输出渲染：保留 ANSI 颜色/粗体（ansi-to-html，escapeXML 转义），
 * 剥离光标移动/清屏等非展示序列；容器固定深色底，maxHeight 内部滚动。
 */
export default function TerminalOutput({ output, maxHeight = '24rem' }: TerminalOutputProps) {
  const html = useMemo(() => ansiToHtml(output), [output]);

  return (
    <div
      data-testid="terminal-output"
      className="overflow-y-auto rounded-lg bg-gray-950 p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap break-all text-green-400"
      style={{ maxHeight }}
      // ansi-to-html 已按 escapeXML 转义，仅输出 span/b 等安全标签
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
